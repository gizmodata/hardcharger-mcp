// A session the server ended because its transaction sat idle past
// --idle-in-transaction-session-timeout (Hardcharger 2.7.0): the client
// (@gizmodata/chargewire 2.1.0) replaces the session and fails the statement that found it
// ended, which must never run again: on the new session, in autocommit, it would commit on
// its own while the transaction's earlier statements had been rolled back. So the MCP server
// answers with the error and does not reconnect and retry, as it does for a killed session.
// The server checks every 5 s, so a transaction idle for 1 s is ended within about 6 s.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import {
  type RunningServer,
  adminConnection,
  failsWith,
  launchServer,
  ok,
  passwordSettings,
  randomName,
  sleep,
  stdioClient,
} from "./harness.ts";

const IDLE_SECONDS = 1;
/** Past the limit and the server's 5 s sweep, with room for a slow runner. */
const PAST_THE_LIMIT_MS = (IDLE_SECONDS + 5 + 3) * 1000;

describe("a transaction left idle (session_ended, idle_in_transaction)", () => {
  let server: RunningServer;
  let rw: Client;
  const stderr: string[] = [];

  before(async () => {
    server = await launchServer({ args: ["--idle-in-transaction-session-timeout", String(IDLE_SECONDS)] });
    rw = await stdioClient({ ...passwordSettings(server), HARDCHARGER_ALLOW_WRITES: "true" }, stderr);
  });

  after(async () => {
    await rw?.close().catch(() => undefined);
    await server?.stop();
  });

  async function count(table: string): Promise<bigint> {
    const admin = await adminConnection(server);
    try {
      const t = await admin.query(`SELECT count(*) AS n FROM ${table}`);
      return t.getChild("n")?.get(0) as bigint;
    } finally {
      await admin.close();
    }
  }

  async function table(): Promise<string> {
    const name = randomName("mcp_idle");
    await ok(rw, "execute_statement", { sql: `CREATE TABLE ${name} (a INTEGER)` });
    return name;
  }

  it("a busy transaction is not ended: it commits (the twin of the next test)", async () => {
    const name = await table();
    await ok(rw, "execute_statement", { sql: "BEGIN" });
    await ok(rw, "execute_statement", { sql: `INSERT INTO ${name} VALUES (1)` });
    await ok(rw, "execute_statement", { sql: "COMMIT" });
    assert.equal(await count(name), 1n);
  });

  it("the statement that finds the transaction ended fails, is not run again, and the next one runs", async () => {
    const name = await table();
    await ok(rw, "execute_statement", { sql: "BEGIN" });
    await ok(rw, "execute_statement", { sql: `INSERT INTO ${name} VALUES (1)` });
    await sleep(PAST_THE_LIMIT_MS);
    const text = await failsWith(rw, "execute_statement", { sql: `INSERT INTO ${name} VALUES (2)` }, "session_ended");
    assert.match(text, /idle_in_transaction/u);
    // Rolled back by the server, and the failed INSERT never ran on a new session.
    assert.equal(await count(name), 0n);
    const info = await ok<{ reconnects: number; session_replacements: number; hardcharger_settings: Record<string, string> }>(
      rw,
      "server_info",
    );
    assert.equal(info.hardcharger_settings["hardcharger.idle_in_transaction_session_timeout"], String(IDLE_SECONDS));
    assert.equal(info.reconnects, 0, "no reconnect and retry: the client replaced the session itself");
    assert.ok(info.session_replacements >= 1, JSON.stringify(info));
    assert.doesNotMatch(stderr.join(""), /connection lost \(session_ended\)/u);
    // The connection goes on, in autocommit, on the new session.
    await ok(rw, "execute_statement", { sql: `INSERT INTO ${name} VALUES (3)` });
    assert.equal(await count(name), 1n);
  });

  it("a session killed after BEGIN is not reopened and retried: the statement fails and did not run (Chargewire §5.7)", async () => {
    const name = await table();
    await ok(rw, "execute_statement", { sql: "BEGIN" });
    await ok(rw, "execute_statement", { sql: `INSERT INTO ${name} VALUES (1)` });
    const sid = (await ok<{ rows: string[][] }>(rw, "run_query", { sql: "SELECT HARDCHARGER_CURRENT_SESSION() AS s" })).rows[0]![0]!;
    const before = (await ok<{ reconnects: number }>(rw, "server_info")).reconnects;
    const admin = await adminConnection(server);
    try {
      await admin.execute(`KILL SESSION '${sid}'`);
    } finally {
      await admin.close();
    }
    const text = await failsWith(rw, "execute_statement", { sql: `INSERT INTO ${name} VALUES (2)` }, /not run again/u);
    assert.match(text, /session_ended/u);
    // Rolled back with the killed session, and the failed INSERT never ran on a new session.
    assert.equal(await count(name), 0n);
    assert.equal((await ok<{ reconnects: number }>(rw, "server_info")).reconnects, before, "no reconnect and retry");
    assert.match(stderr.join(""), /with a transaction possibly open; not retried/u);
    // The next statement runs on a new connection, in autocommit.
    await ok(rw, "execute_statement", { sql: `INSERT INTO ${name} VALUES (3)` });
    assert.equal(await count(name), 1n);
  });
});
