// The connection layer against a scripted client: session options for the search path,
// the reconnect-once policy, the timeout mapping, the capped stream and Arrow parameters.
// The same behaviour runs against a real server in test/live.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardchargerError } from "@gizmodata/hardcharger";
import { type RecordBatch, Table, tableFromArrays } from "apache-arrow";

import { HardchargerConnection, QueryTimeoutError, parseConfig } from "../../dist/connection.js";
import { convertParams } from "../../dist/params.js";

const hcError = (code: string, extra: Record<string, unknown> = {}) =>
  new HardchargerError({ code, message: `scripted (${code})`, ...extra } as ConstructorParameters<typeof HardchargerError>[0]);

interface Call {
  op: string;
  arg?: unknown;
  options?: Record<string, unknown>;
}

/** A scripted client: records every call; `failures` makes the named operations throw once each. */
function fakeServer(script: { failures?: Record<string, unknown[]>; badCatalogs?: string[]; replacements?: number } = {}) {
  const calls: Call[] = [];
  let opened = 0;
  const fail = (op: string) => {
    const queue = script.failures?.[op];
    if (queue && queue.length > 0) {
      const err = queue.shift(); // undefined: this call succeeds
      if (err !== undefined) throw err;
    }
  };
  let session: Record<string, unknown> = { catalog: "memory", schema: "main" };
  const connect = async (options: Record<string, unknown>) => {
    opened++;
    calls.push({ op: "connect", arg: options.url, options });
    fail("connect");
    const stream = (rows: number, options: Record<string, unknown>) => {
      const batches = Array.from({ length: Math.ceil(rows / 10) }, (_, b) =>
        tableFromArrays({ i: Int32Array.from({ length: Math.min(10, rows - b * 10) }, (_, k) => b * 10 + k) }).batches[0]!,
      );
      let read = 0;
      let closed = false;
      return {
        options,
        async schema() {
          return tableFromArrays({ i: Int32Array.from([]) }).schema;
        },
        async close() {
          closed = true;
          calls.push({ op: "stream.close", arg: read });
        },
        async *[Symbol.asyncIterator](): AsyncGenerator<RecordBatch> {
          for (const b of batches) {
            if (closed) return;
            read++;
            yield b;
          }
        },
      };
    };
    return {
      sessionReplacements: script.replacements ?? 0,
      server: { protocol: "warp-sql", protocol_versions: ["1"], capabilities: ["prepared_statements"] },
      metadata: {
        async catalogs() {
          return tableFromArrays({ catalog_name: ["memory", "system"] });
        },
      },
      async setOptions(o: Record<string, unknown>) {
        calls.push({ op: "setOptions", arg: o });
        fail("setOptions");
        if (typeof o.catalog === "string" && script.badCatalogs?.includes(o.catalog)) {
          throw hcError("invalid_option_value");
        }
        session = { ...session, ...o };
        return session;
      },
      async getSession() {
        return { session_id: "s", options: session, idle_timeout_s: 600 };
      },
      async query(sql: string, _params: unknown, options: Record<string, unknown>) {
        calls.push({ op: "query", arg: sql, options });
        fail("query");
        return tableFromArrays({ name: [] as string[], value: [] as string[] });
      },
      async execute(sql: string, _params: unknown, options: Record<string, unknown>) {
        calls.push({ op: "execute", arg: sql, options });
        fail("execute");
        return null;
      },
      stream(sql: string, _params: unknown, options: Record<string, unknown>) {
        calls.push({ op: "stream", arg: sql, options });
        return stream(25, options);
      },
      async prepare(sql: string) {
        calls.push({ op: "prepare", arg: sql });
        return {
          stream(params: unknown, options: Record<string, unknown>) {
            calls.push({ op: "prepared.stream", arg: params, options });
            return stream(3, options);
          },
          async execute(params: unknown) {
            calls.push({ op: "prepared.execute", arg: params });
            return 1;
          },
          async close() {
            calls.push({ op: "prepared.close" });
          },
        };
      },
      async close() {
        calls.push({ op: "close" });
      },
    };
  };
  return { calls, connect, opened: () => opened };
}

function connection(env: Record<string, string>, server: ReturnType<typeof fakeServer>) {
  const cfg = parseConfig({
    HARDCHARGER_URI: "hardcharger://db.internal",
    HARDCHARGER_USERNAME: "svc",
    HARDCHARGER_PASSWORD: "secret",
    ...env,
  });
  const logs: string[] = [];
  const conn = new HardchargerConnection(cfg.connections[0], (m) => logs.push(m), { connect: server.connect as never });
  return { conn, logs };
}

describe("HardchargerConnection", () => {
  it("applies the default catalog and schema as session options (which the client replays)", async () => {
    const server = fakeServer();
    const { conn } = connection({ HARDCHARGER_DEFAULT_CATALOG: "lake", HARDCHARGER_DEFAULT_SCHEMA: "sales" }, server);
    await conn.query("SELECT 1");
    const set = server.calls.find((c) => c.op === "setOptions");
    assert.deepEqual(set?.arg, { catalog: "lake", schema: "sales" });
    assert.deepEqual(conn.sessionWarnings(), []);
    assert.ok(server.calls.some((c) => c.op === "query" && /hardcharger_settings\(\)/u.test(String(c.arg))));
  });

  it("keeps running with a warning that lists the catalogs when the default does not exist", async () => {
    const server = fakeServer({ badCatalogs: ["nope"] });
    const { conn, logs } = connection({ HARDCHARGER_DEFAULT_CATALOG: "nope" }, server);
    await conn.query("SELECT 1");
    const warnings = conn.sessionWarnings();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Default catalog\/schema could not be applied \(nope\)/);
    assert.match(warnings[0]!, /Available catalogs: memory, system\./);
    assert.match(warnings[0]!, /invalid_option_value/);
    assert.ok(logs.some((l) => l.includes("warning: Default catalog")));
  });

  it("use_schema sets the session options and pins the resulting catalog and schema together", async () => {
    const server = fakeServer();
    const { conn } = connection({}, server);
    const path = await conn.useSchema({ schema: "alt" });
    assert.deepEqual(path, { catalog: "memory", schema: "alt" });
    const sets = server.calls.filter((c) => c.op === "setOptions").map((c) => c.arg);
    assert.deepEqual(sets, [{ schema: "alt" }, { catalog: "memory", schema: "alt" }]);
    assert.deepEqual(conn.currentSearchPath(), { catalog: "memory", schema: "alt" });
  });

  it("reopens the connection once when an administrator ended the session, and retries", async () => {
    const server = fakeServer({ failures: { execute: [hcError("session_ended", { reason: "killed" })] } });
    const { conn, logs } = connection({}, server);
    assert.equal(await conn.update("DELETE FROM t"), -1, "a null count is reported as -1");
    assert.equal(server.opened(), 2);
    assert.equal(conn.reconnects, 1);
    assert.ok(logs.some((l) => /connection lost \(session_ended\), reconnecting/u.test(l)), logs.join("\n"));
  });

  it("gives up after one reconnect, and never retries a refused credential", async () => {
    const twice = fakeServer({ failures: { execute: [hcError("transport_error"), hcError("transport_error")] } });
    await assert.rejects(connection({}, twice).conn.update("SELECT 1"), (err: HardchargerError) => err.code === "transport_error");
    assert.equal(twice.opened(), 2);

    const refused = fakeServer({ failures: { execute: [hcError("invalid_credentials")] } });
    await assert.rejects(connection({}, refused).conn.update("SELECT 1"), (err: HardchargerError) => err.code === "invalid_credentials");
    assert.equal(refused.opened(), 1);
  });

  it("sends the server-side timeout with each statement and maps statement_timeout to QueryTimeoutError", async () => {
    const server = fakeServer({ failures: { query: [undefined, hcError("statement_timeout")] } });
    const { conn } = connection({ HARDCHARGER_QUERY_TIMEOUT_SECONDS: "7" }, server);
    await assert.rejects(conn.query("SELECT slow()"), (err: Error) => {
      assert.ok(err instanceof QueryTimeoutError);
      assert.match(err.message, /7s timeout .*\(statement_timeout\)/);
      return true;
    });
    const q = server.calls.filter((c) => c.op === "query").at(-1)!;
    assert.equal(q.options?.statementTimeoutMs, 7000);
    assert.ok(q.options?.signal instanceof AbortSignal);
  });

  it("reads a capped result from one stream and stops at max_rows + 1", async () => {
    const server = fakeServer();
    const { conn } = connection({}, server);
    const capped = await conn.queryCapped("SELECT i FROM t", undefined, 12);
    assert.equal(capped.table.numRows, 12);
    assert.equal(capped.truncated, true);
    const s = server.calls.find((c) => c.op === "stream")!;
    assert.equal(s.options?.resultPartitions, 1);
    assert.deepEqual(server.calls.filter((c) => c.op === "stream.close").map((c) => c.arg), [2], "stopped after two batches");

    const all = await conn.queryCapped("SELECT i FROM t", undefined, 100);
    assert.equal(all.table.numRows, 25);
    assert.equal(all.truncated, false);
  });

  it("prepares the statement for Arrow parameters and closes it afterwards", async () => {
    const server = fakeServer();
    const { conn } = connection({}, server);
    const params = convertParams([{ type: "date", value: "2024-01-02" }]);
    assert.ok(params instanceof Table);
    const capped = await conn.queryCapped("SELECT ? AS d", params, 10);
    assert.equal(capped.table.numRows, 3);
    const ops = server.calls.map((c) => c.op).filter((op) => op.startsWith("prepare"));
    assert.deepEqual(ops, ["prepare", "prepared.stream", "prepared.close"]);
    assert.equal(await conn.update("INSERT INTO t VALUES (?)", params), 1);
  });

  it("explains a TLS handshake against a plain-HTTP server", async () => {
    const server = fakeServer({
      failures: {
        connect: [
          hcError("transport_error", {
            message: "GET : fetch failed: error:0A00010B:SSL routines::wrong version number (ERR_SSL_WRONG_VERSION_NUMBER)",
          }),
        ],
      },
    });
    const { conn } = connection({}, server);
    await assert.rejects(conn.query("SELECT 1"), /speaks plain HTTP, not TLS: add \?tls=false/);
  });

  it("counts session replacements across the clients it opened", async () => {
    const server = fakeServer({ replacements: 2, failures: { execute: [hcError("connection_closed")] } });
    const { conn } = connection({}, server);
    await conn.update("SELECT 1");
    assert.equal(conn.sessionReplacements(), 4, "two before the reconnect, two on the new client");
    assert.equal(await conn.sessionIdleTimeoutSeconds(), 600);
  });
});
