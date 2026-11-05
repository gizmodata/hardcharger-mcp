// A server that is resuming (server_resuming) and a connection lost while a transaction may
// have been open, against a scripted client:
//   - HARDCHARGER_RESUME_TIMEOUT_SECONDS reaches the client as resumeTimeout, and each wait the
//     client reports (onResuming) is logged; a call whose time runs out while the server is
//     still resuming says so (ServerResumingError), not "the query was slow";
//   - after SQL that can begin a transaction ran on the connection, a lost session is never
//     retried here (Chargewire §5.7): on a new session the statement would run alone, in
//     autocommit. Without such SQL, the reconnect-once retry stays (connection.test.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type ConnectOptions, HardchargerError } from "@gizmodata/hardcharger";
import { tableFromArrays } from "apache-arrow";

import {
  DEFAULTS,
  HardchargerConnection,
  ServerResumingError,
  SettingsLostError,
  TransactionLostError,
  changesSettings,
  mayOpenTransaction,
  parseConfig,
} from "../../dist/connection.js";

const hcError = (code: string, extra: Record<string, unknown> = {}) =>
  new HardchargerError({ code, message: `scripted (${code})`, ...extra } as ConstructorParameters<typeof HardchargerError>[0]);

interface Script {
  /** Errors the next `execute` calls throw, in order (undefined: succeeds). */
  execute?: unknown[];
  /** Errors the next metadata calls throw. */
  catalogs?: unknown[];
  /** A query that reports a resuming server and then waits for its signal. */
  resumingQuery?: boolean;
}

function scripted(script: Script = {}) {
  const executed: string[] = [];
  const optionsSet: Record<string, unknown>[] = [];
  const opened: ConnectOptions[] = [];
  const connect = async (options: ConnectOptions) => {
    opened.push(options);
    return {
      sessionReplacements: 0,
      server: { protocol: "chargewire", protocol_versions: ["1"], capabilities: [] },
      metadata: {
        async catalogs() {
          const err = script.catalogs?.shift();
          if (err !== undefined) throw err;
          return tableFromArrays({ catalog_name: ["memory"] });
        },
      },
      async setOptions(o: Record<string, unknown>) {
        optionsSet.push(o);
        return o;
      },
      async getSession() {
        // What a server before Chargewire 2.2.1 can answer right after a USE on the streamed path.
        return { session_id: "s", options: { catalog: "memory", schema: "main" }, idle_timeout_s: 600 };
      },
      async query(sql: string, _params: unknown, call: { signal?: AbortSignal }) {
        if (/current_database\(\)/u.test(sql)) {
          return tableFromArrays({ catalog_name: ["lake"], schema_name: ["sales"] });
        }
        if (script.resumingQuery && !/hardcharger_settings/u.test(sql)) {
          options.onResuming?.({
            attempt: 1,
            retryAfterMs: 3000,
            elapsedMs: 0,
            resumeTimeoutMs: 600_000,
            detail: "the cluster is starting",
          });
          await new Promise((_resolve, reject) =>
            call.signal?.addEventListener("abort", () => reject(hcError("statement_cancelled")), { once: true }),
          );
        }
        return tableFromArrays({ name: [] as string[], value: [] as string[] });
      },
      async execute(sql: string) {
        executed.push(sql);
        const err = script.execute?.shift();
        if (err !== undefined) throw err;
        return 0;
      },
      async close() {},
    };
  };
  return { connect, executed, opened, optionsSet };
}

function connection(env: Record<string, string>, server: ReturnType<typeof scripted>) {
  const cfg = parseConfig({
    HARDCHARGER_URI: "hardcharger://db.internal",
    HARDCHARGER_USERNAME: "svc",
    HARDCHARGER_PASSWORD: "secret",
    ...env,
  });
  const logs: string[] = [];
  const conn = new HardchargerConnection(cfg.connections[0]!, (m) => logs.push(m), { connect: server.connect as never });
  return { conn, logs, cfg };
}

describe("a server that is resuming", () => {
  it("HARDCHARGER_RESUME_TIMEOUT_SECONDS reaches the client (default 600, 0 allowed, bad values refused)", async () => {
    assert.equal(DEFAULTS.resumeTimeoutSeconds, 600);
    for (const [value, want] of [
      [undefined, 600],
      ["120", 120],
      ["0", 0],
    ] as const) {
      const server = scripted();
      const { conn, cfg } = connection(value === undefined ? {} : { HARDCHARGER_RESUME_TIMEOUT_SECONDS: value }, server);
      assert.equal(cfg.resumeTimeoutSeconds, want);
      await conn.update("SELECT 1");
      assert.equal(server.opened[0]!.resumeTimeout, want);
      assert.equal(typeof server.opened[0]!.onResuming, "function");
    }
    for (const bad of ["-1", "abc", "3601"]) {
      assert.throws(
        () => parseConfig({ HARDCHARGER_URI: "hardcharger://h", HARDCHARGER_TOKEN: "t", HARDCHARGER_RESUME_TIMEOUT_SECONDS: bad }),
        /HARDCHARGER_RESUME_TIMEOUT_SECONDS/u,
      );
    }
  });

  it("logs each wait the client reports, and says the server is resuming when the call's time runs out", async () => {
    const server = scripted({ resumingQuery: true });
    const { conn, logs } = connection({ HARDCHARGER_QUERY_TIMEOUT_SECONDS: "1" }, server);
    await assert.rejects(conn.query("SELECT 1"), (err: Error) => {
      assert.ok(err instanceof ServerResumingError, String(err));
      assert.match(err.message, /is resuming \(a stopped server starting again: the cluster is starting\)/u);
      assert.match(err.message, /did not run\. Try again in a minute\./u);
      return true;
    });
    assert.ok(
      logs.some((l) => /default: the server is resuming \(attempt 1, 0s of 600s; next try in 3s\): the cluster is starting/u.test(l)),
      logs.join("\n"),
    );
  });
});

describe("a lost session after SQL that can begin a transaction (Chargewire §5.7)", () => {
  it("is not retried after BEGIN: the statement does not run again, and the next call opens afresh", async () => {
    const server = scripted({ execute: [undefined, undefined, hcError("session_ended", { reason: "killed" })] });
    const { conn, logs } = connection({}, server);
    await conn.update("BEGIN");
    await conn.update("INSERT INTO t VALUES (1)");
    await assert.rejects(conn.update("INSERT INTO t VALUES (2)"), (err: Error) => {
      assert.ok(err instanceof TransactionLostError, String(err));
      assert.match(err.message, /lost its Hardcharger session \(session_ended\)/u);
      assert.match(err.message, /this statement was not run again/u);
      return true;
    });
    assert.deepEqual(server.executed, ["BEGIN", "INSERT INTO t VALUES (1)", "INSERT INTO t VALUES (2)"]);
    assert.equal(conn.reconnects, 0);
    assert.ok(logs.some((l) => /with a transaction possibly open; not retried/u.test(l)), logs.join("\n"));
    // The next call opens a new connection, and the mark is gone with the old one.
    await conn.update("INSERT INTO t VALUES (3)");
    assert.equal(server.opened.length, 2);
  });

  it("its twin: the same loss without BEGIN is retried once on a new connection", async () => {
    const server = scripted({ execute: [undefined, hcError("session_ended", { reason: "killed" })] });
    const { conn } = connection({}, server);
    await conn.update("INSERT INTO t VALUES (1)");
    assert.equal(await conn.update("INSERT INTO t VALUES (2)"), 0);
    assert.deepEqual(server.executed, ["INSERT INTO t VALUES (1)", "INSERT INTO t VALUES (2)", "INSERT INTO t VALUES (2)"]);
    assert.equal(conn.reconnects, 1);
  });

  it("when the client already opened a replacement session, it is used: no new connection, no retry", async () => {
    const lost = hcError("session_not_found", { lostSessionId: "s1", replacementSessionId: "s2" });
    const server = scripted({ execute: [undefined, lost, hcError("session_ended", { reason: "killed" })] });
    const { conn } = connection({}, server);
    await conn.update("START TRANSACTION");
    await assert.rejects(conn.update("UPDATE t SET a = 1"), TransactionLostError);
    assert.equal(server.opened.length, 1);
    // The replacement starts clean: a later loss, with no BEGIN since, is retried once again.
    assert.equal(await conn.update("SELECT 1"), 0);
    assert.equal(conn.reconnects, 1);
    assert.deepEqual(server.executed.slice(-2), ["SELECT 1", "SELECT 1"]);
  });

  it("a metadata call that finds the loss fails too, instead of hiding it", async () => {
    const server = scripted({ catalogs: [hcError("client_transport_error")] });
    const { conn } = connection({ HARDCHARGER_ALLOW_WRITES: "true" }, server);
    await conn.update("BEGIN");
    await assert.rejects(
      conn.run((c) => c.metadata.catalogs()),
      TransactionLostError,
    );
  });

  it("which SQL may begin a transaction", () => {
    for (const sql of ["BEGIN", "begin transaction", "START\nTRANSACTION", "SET autocommit = false", "/* begin */ SELECT 1"]) {
      assert.equal(mayOpenTransaction(sql), true, sql);
    }
    for (const sql of ["SELECT 1", "SELECT begin_date FROM t", "SELECT started FROM t"]) {
      assert.equal(mayOpenTransaction(sql), false, sql);
    }
  });
});

describe("a lost session after SQL that changed session settings (SET, RESET, PRAGMA)", () => {
  it("is not retried after SET: the statement does not run again on a session without the setting", async () => {
    const server = scripted({ execute: [undefined, hcError("session_ended", { reason: "killed" })] });
    const { conn, logs } = connection({}, server);
    await conn.update("SET threads = 1");
    await assert.rejects(conn.update("INSERT INTO t VALUES (1)"), (err: Error) => {
      assert.ok(err instanceof SettingsLostError, String(err));
      assert.match(err.message, /changes the session's settings \(SET, RESET or PRAGMA\)/u);
      assert.match(err.message, /this statement was not run again/u);
      return true;
    });
    assert.deepEqual(server.executed, ["SET threads = 1", "INSERT INTO t VALUES (1)"]);
    assert.equal(conn.reconnects, 0);
    assert.ok(logs.some((l) => /session settings set by SQL; not retried/u.test(l)), logs.join("\n"));
  });

  it("its twin: UPDATE ... SET is not a SET statement, and the loss is retried once", async () => {
    const server = scripted({ execute: [undefined, hcError("session_ended", { reason: "killed" })] });
    const { conn } = connection({}, server);
    await conn.update("UPDATE t SET a = 1");
    assert.equal(await conn.update("INSERT INTO t VALUES (1)"), 0);
    assert.equal(conn.reconnects, 1);
  });

  it("when the client already opened a replacement after PRAGMA, it is used, without a retry", async () => {
    const lost = hcError("session_not_found", { lostSessionId: "s1", replacementSessionId: "s2" });
    const server = scripted({ execute: [undefined, lost] });
    const { conn } = connection({}, server);
    await conn.update("PRAGMA enable_progress_bar");
    await assert.rejects(conn.update("INSERT INTO t VALUES (1)"), SettingsLostError);
    assert.equal(server.opened.length, 1);
  });

  it("which SQL changes session settings: the first word of each statement, USE aside", () => {
    for (const sql of ["SET threads = 1", "reset threads", "PRAGMA x", "-- c\nSET a = 1", "SELECT 1; SET a = 1"]) {
      assert.equal(changesSettings(sql), true, sql);
    }
    for (const sql of ["UPDATE t SET a = 1", "USE lake.sales", "SELECT reset_at FROM t", "INSERT INTO settings VALUES (1)"]) {
      assert.equal(changesSettings(sql), false, sql);
    }
  });
});

describe("a USE through run_query is pinned from the engine, not from the session document", () => {
  it("reads current_database() and current_schema(), and sets both as session options", async () => {
    const server = scripted();
    const { conn } = connection({}, server);
    const path = await conn.syncSearchPath();
    assert.deepEqual(path, { catalog: "lake", schema: "sales" });
    assert.deepEqual(server.optionsSet.at(-1), { catalog: "lake", schema: "sales" });
  });
});
