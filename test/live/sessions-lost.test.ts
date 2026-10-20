// Lost sessions against a real hardcharger-server, each with the search path as the
// witness (unqualified `whoami` resolves in mcp_ver only while it holds):
//   - the server's idle timeout evicts a quiet session: the client opens a replacement and
//     replays the catalog and schema, including ones set later by use_schema or USE;
//   - an administrator kills the session (KILL SESSION, session_ended): the MCP server
//     reconnects once and retries;
//   - the server restarts under a live connection (a new process, new signing key): the
//     client signs in again and opens a new session.
// GizmoSQL 1.x needed a timed "refresh" of the search path for the first case, because its
// server silently recreated an evicted session; Warp SQL reports it (session_not_found).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import {
  type RunningServer,
  adminConnection,
  launchServer,
  ok,
  passwordSettings,
  sleep,
  stdioClient,
} from "./harness.ts";

/** Seconds a session may idle before the server evicts it; its sweep is not instant. */
const IDLE_SECONDS = 1;
const PAST_IDLE_MS = 8000;

async function fixture(server: RunningServer): Promise<void> {
  const admin = await adminConnection(server);
  try {
    for (const schema of ["mcp_ver", "mcp_other"]) {
      await admin.execute(`CREATE SCHEMA IF NOT EXISTS memory.${schema}`);
      await admin.execute(`CREATE OR REPLACE TABLE memory.${schema}.whoami AS SELECT '${schema}' AS schema_name`);
    }
  } finally {
    await admin.close();
  }
}

async function schemaSeenBy(client: Client): Promise<string> {
  const r = await ok<{ rows: string[][] }>(client, "run_query", { sql: "SELECT schema_name FROM whoami" });
  return r.rows[0]![0]!;
}

interface Counters {
  session_replacements: number;
  reconnects: number;
  hardcharger_session_idle_timeout_seconds: number | null;
}

describe("lost sessions", () => {
  let server: RunningServer;
  const clients: Client[] = [];
  const stderr: string[] = [];

  async function mcp(): Promise<Client> {
    const client = await stdioClient(
      { ...passwordSettings(server), HARDCHARGER_DEFAULT_CATALOG: "memory", HARDCHARGER_DEFAULT_SCHEMA: "mcp_ver" },
      stderr,
    );
    clients.push(client);
    return client;
  }

  before(async () => {
    server = await launchServer({ args: ["--session-idle-timeout", String(IDLE_SECONDS)] });
    await fixture(server);
  });

  after(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await server?.stop();
  });

  it("an evicted idle session is replaced with the same search path, and the replacement is reported", async () => {
    const client = await mcp();
    assert.equal(await schemaSeenBy(client), "mcp_ver");
    const before = await ok<Counters>(client, "server_info");
    assert.equal(before.hardcharger_session_idle_timeout_seconds, IDLE_SECONDS);
    await sleep(PAST_IDLE_MS);
    assert.equal(await schemaSeenBy(client), "mcp_ver", "the search path survived eviction");
    const counters = await ok<Counters>(client, "server_info");
    assert.ok(counters.session_replacements >= 1, JSON.stringify(counters));
    assert.equal(counters.reconnects, 0, "the client replaced the session itself");
    assert.ok(stderr.join("").includes("the server lost the session; opened a replacement"), "the replacement is logged");
  });

  it("use_schema and a plain USE are replayed on the replacement session too", async () => {
    const client = await mcp();
    await ok(client, "use_schema", { schema: "mcp_other" });
    await sleep(PAST_IDLE_MS);
    assert.equal(await schemaSeenBy(client), "mcp_other", "use_schema survived eviction");
    await ok(client, "run_query", { sql: "USE memory.mcp_ver" });
    await sleep(PAST_IDLE_MS);
    assert.equal(await schemaSeenBy(client), "mcp_ver", "USE survived eviction");
  });

  it("a session an administrator killed (session_ended) is reopened once, transparently", async () => {
    const client = await mcp();
    const sid = (await ok<{ rows: string[][] }>(client, "run_query", { sql: "SELECT HARDCHARGER_CURRENT_SESSION() AS s" })).rows[0]![0]!;
    const admin = await adminConnection(server);
    try {
      await admin.execute(`KILL SESSION '${sid}'`);
    } finally {
      await admin.close();
    }
    assert.equal(await schemaSeenBy(client), "mcp_ver", "reconnected with the search path");
    const counters = await ok<Counters>(client, "server_info");
    assert.equal(counters.reconnects, 1);
    assert.match(stderr.join(""), /connection lost \(session_ended\), reconnecting: .*killed/);
  });

  it("a server restart under a live connection is survived: a new sign-in and session", async () => {
    const client = await mcp();
    assert.equal(await schemaSeenBy(client), "mcp_ver");
    await server.restart(); // a new process: a new signing key, no sessions, an empty database
    await fixture(server);
    assert.equal(await schemaSeenBy(client), "mcp_ver", "reconnected with a fresh sign-in and search path");
  });
});
