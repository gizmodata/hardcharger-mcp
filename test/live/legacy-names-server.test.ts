// A Hardcharger released before the protocol was renamed to Chargewire (2.2.0 and earlier),
// reached through the MCP server: the client finds nothing at /chargewire, falls back to
// /warp and speaks the old spelling there. Current URIs and URIs written before the rename
// both work.
//
// The server is one that is already running, plain HTTP (the image, say):
//
//   HARDCHARGER_MCP_TEST_OLD_SERVER            host:port, e.g. 127.0.0.1:31347
//   HARDCHARGER_MCP_TEST_OLD_SERVER_PASSWORD   its administrator's password
//   HARDCHARGER_MCP_TEST_OLD_SERVER_USERNAME   its administrator (default: hardcharger)
//
// Without them these tests fail; nothing skips. scripts/run-live.mjs leaves this file out on a
// developer's machine when HARDCHARGER_MCP_TEST_OLD_SERVER is not set, never in CI.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { call, ok, stdioClient, textOf } from "./harness.ts";

const address = process.env.HARDCHARGER_MCP_TEST_OLD_SERVER ?? "";
const password = process.env.HARDCHARGER_MCP_TEST_OLD_SERVER_PASSWORD ?? "";
const username = process.env.HARDCHARGER_MCP_TEST_OLD_SERVER_USERNAME || "hardcharger";

function settings(uri: string, extra: Record<string, string> = {}): Record<string, string> {
  return { HARDCHARGER_URI: uri, HARDCHARGER_USERNAME: username, HARDCHARGER_PASSWORD: password, ...extra };
}

describe("hardcharger-mcp against a Hardcharger from before the rename", () => {
  let rw: Client;

  before(async () => {
    if (address === "" || password === "") {
      throw new Error(
        "FAIL: set HARDCHARGER_MCP_TEST_OLD_SERVER (host:port) and HARDCHARGER_MCP_TEST_OLD_SERVER_PASSWORD",
      );
    }
    rw = await stdioClient(settings(`hardcharger://${address}?tls=false`, { HARDCHARGER_ALLOW_WRITES: "true" }));
  });

  after(async () => {
    await rw?.close().catch(() => undefined);
  });

  it("server_info connects with a current hardcharger:// URI", async () => {
    const s = await ok(rw, "server_info");
    assert.match(String(s.hardcharger_version), /^\d+\.\d+\.\d+/);
    assert.equal(s.user, username);
    assert.equal(s.protocol, "chargewire 1");
    assert.ok((s.capabilities as string[]).includes("prepared_statements"));
  });

  it("run_query: SELECT 42 and a small query", async () => {
    const answer = await ok<{ rows: unknown[][] }>(rw, "run_query", { sql: "SELECT 42 AS answer" });
    assert.deepEqual(answer.rows, [[42]]);
    const small = await ok<{ rows: unknown[][]; row_count: number }>(rw, "run_query", {
      sql: "SELECT range::INTEGER AS i, 'n' || range AS s FROM range(3) ORDER BY i",
    });
    assert.equal(small.row_count, 3);
    assert.deepEqual(small.rows, [
      [0, "n0"],
      [1, "n1"],
      [2, "n2"],
    ]);
  });

  it("execute_statement with bound parameters, then the metadata tools", async () => {
    await ok(rw, "execute_statement", { sql: "DROP TABLE IF EXISTS mcp_legacy" });
    await ok(rw, "execute_statement", {
      sql: "CREATE TABLE mcp_legacy (id INTEGER PRIMARY KEY, label VARCHAR DEFAULT 'xyz')",
    });
    const inserted = await ok<{ affected_rows: number }>(rw, "execute_statement", {
      sql: "INSERT INTO mcp_legacy VALUES (?, ?), (?, ?)",
      params: [1, "one", 2, "two"],
    });
    assert.equal(inserted.affected_rows, 2);
    const bound = await ok<{ rows: unknown[][] }>(rw, "run_query", {
      sql: "SELECT label FROM mcp_legacy WHERE id = ?",
      params: [2],
    });
    assert.deepEqual(bound.rows, [["two"]]);
    const tables = await call(rw, "list_tables", { like: "mcp_legacy" });
    assert.match(textOf(tables), /\| mcp_legacy \| BASE TABLE \|/);
    const described = await call(rw, "describe_table", { table: "mcp_legacy" });
    assert.equal(described.isError, undefined, textOf(described));
    assert.match(textOf(described), /\| label \| VARCHAR \| YES \|/);
    assert.match(textOf(described), /xyz/, "the column default, under the server's metadata key");
  });

  it("a SQL error keeps its code", async () => {
    const r = await call(rw, "run_query", { sql: "SELECT * FROM no_such_table_here" });
    assert.equal(r.isError, true);
    assert.ok(textOf(r).includes("sql_error"), textOf(r));
  });

  for (const uri of [`warp://${address}?tls=false`, `http://${address}/warp`, `hardcharger://${address}/warp?tls=false`]) {
    it(`a URI written before the rename connects: ${uri}`, async () => {
      const client = await stdioClient(settings(uri));
      try {
        const r = await ok<{ rows: unknown[][] }>(client, "run_query", { sql: "SELECT 3 AS n" });
        assert.deepEqual(r.rows, [[3]]);
      } finally {
        await client.close().catch(() => undefined);
      }
    });
  }
});
