// Every tool, over stdio and Streamable HTTP, against a real hardcharger-server
// (HARDCHARGER_MCP_TEST_SERVER_BINARY; see harness.ts). The MCP server runs as
// `node dist/cli.js`, the way Claude Desktop and Claude Code start it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  type RunningServer,
  adminConnection,
  adminUsername,
  call,
  failsWith,
  launchServer,
  mcpEnv,
  ok,
  passwordSettings,
  stdioClient,
  textOf,
} from "./harness.ts";

describe("hardcharger-mcp tools against hardcharger-server", () => {
  let server: RunningServer;
  let ro: Client;
  let rw: Client;

  before(async () => {
    server = await launchServer();
    ro = await stdioClient({
      ...passwordSettings(server),
      HARDCHARGER_MAX_ROWS: "5",
      HARDCHARGER_MAX_CELL_CHARS: "10",
      HARDCHARGER_QUERY_TIMEOUT_SECONDS: "2",
    });
    rw = await stdioClient({ ...passwordSettings(server), HARDCHARGER_ALLOW_WRITES: "true" });
  });

  after(async () => {
    await ro?.close().catch(() => undefined);
    await rw?.close().catch(() => undefined);
    await server?.stop();
  });

  it("registers the read-only tool set (no execute_statement) and the schema resource", async () => {
    const tools = (await ro.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [
      "describe_table",
      "explain_query",
      "list_catalogs",
      "list_connections",
      "list_schemas",
      "list_tables",
      "run_query",
      "server_info",
      "use_connection",
      "use_schema",
    ]);
    const runQuery = (await ro.listTools()).tools.find((t) => t.name === "run_query");
    assert.equal(runQuery?.annotations?.readOnlyHint, true);
    const templates = (await ro.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    assert.deepEqual(templates, ["hardcharger://{connection}/schema/{catalog}/{schema}/{table}"]);
  });

  it("registers execute_statement when writes are enabled", async () => {
    const tools = (await rw.listTools()).tools;
    const exec = tools.find((t) => t.name === "execute_statement");
    assert.ok(exec);
    assert.equal(exec.annotations?.destructiveHint, true);
  });

  it("server_info reports versions, the user, the protocol and redacts credentials", async () => {
    const r = await call(ro, "server_info");
    assert.equal(r.isError, undefined, textOf(r));
    const text = textOf(r);
    const s = r.structuredContent as Record<string, unknown>;
    assert.match(String(s.hardcharger_version), /^\d+\.\d+\.\d+/);
    assert.match(String(s.duckdb_version), /^v\d+/);
    assert.equal(s.connection_uri, server.uri);
    assert.equal(s.user, adminUsername);
    assert.equal(s.role, "admin");
    assert.equal(s.auth_method, "password");
    assert.equal(s.tls, false);
    assert.equal(s.protocol, "warp-sql 1");
    assert.ok((s.capabilities as string[]).includes("prepared_statements"));
    assert.equal((s.hardcharger_settings as Record<string, string>)["hardcharger.version"], s.hardcharger_version);
    assert.equal(typeof s.hardcharger_session_idle_timeout_seconds, "number");
    assert.equal(s.allow_writes, false);
    assert.ok(!text.includes(server.password), "the password never appears");
  });

  it("execute_statement creates and populates a table, with JSON and Arrow parameters", async () => {
    await ok(rw, "execute_statement", { sql: "DROP TABLE IF EXISTS mcp_it" });
    await ok(rw, "execute_statement", {
      sql: "CREATE TABLE mcp_it (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, amount DECIMAL(10,2), seen_at TIMESTAMP, d DATE, payload BLOB)",
    });
    const inserted = await ok<{ affected_rows: number }>(rw, "execute_statement", {
      sql: "INSERT INTO mcp_it SELECT range, 'name-' || range || ' with a long suffix', range * 1.25, TIMESTAMP '2024-01-02 03:04:05', NULL, NULL FROM range(20)",
    });
    assert.equal(inserted.affected_rows, 20);
    // JSON parameters: the server types the timestamp string from its column.
    const bound = await ok<{ affected_rows: number }>(rw, "execute_statement", {
      sql: "INSERT INTO mcp_it VALUES (?, ?, ?, ?, NULL, NULL)",
      params: [100, "bound", { type: "number", value: "9.99" }, "2024-05-06T07:08:09Z"],
    });
    assert.equal(bound.affected_rows, 1);
    // Arrow parameters: a date and binary value, which JSON cannot carry.
    const typed = await ok<{ affected_rows: number }>(rw, "execute_statement", {
      sql: "INSERT INTO mcp_it VALUES (?, ?, NULL, NULL, ?, ?)",
      params: [101, "typed", { type: "date", value: "2024-02-29" }, { type: "binary", value: Buffer.from([0xca, 0xfe]).toString("base64") }],
    });
    assert.equal(typed.affected_rows, 1);
    const back = await ok<{ rows: unknown[][] }>(ro, "run_query", {
      sql: "SELECT d, payload FROM mcp_it WHERE id = ?",
      params: [101],
    });
    assert.deepEqual(back.rows, [["2024-02-29", Buffer.from([0xca, 0xfe]).toString("base64")]]);
  });

  it("rejects a placeholder/parameter count mismatch before the query is sent", async () => {
    const short = await failsWith(ro, "run_query", { sql: "SELECT ?::INTEGER AS a, ?::INTEGER AS b", params: [1] }, /2 placeholders .* 1 parameter was supplied/);
    assert.doesNotMatch(short, /LIMIT|sql_error/);
    await failsWith(ro, "run_query", { sql: "SELECT 1", params: [1] }, /0 placeholders .* 1 parameter/);
  });

  it("a server error keeps DuckDB's message with its Warp SQL code (sql_error) and SQLSTATE", async () => {
    const bad = await failsWith(ro, "run_query", { sql: "SELECT no_such_column FROM mcp_it" }, "sql_error");
    assert.match(bad, /Binder Error/);
    const missing = await failsWith(ro, "run_query", { sql: "SELECT * FROM no_such_table" }, "sql_error");
    assert.match(missing, /no_such_table does not exist/);
    assert.match(missing, /SQLSTATE 42P01/);
    // The positive twin: the same table, a column that exists.
    await ok(ro, "run_query", { sql: "SELECT id FROM mcp_it LIMIT 1" });
  });

  it("metadata tools see the table", async () => {
    const catalogs = await ok<{ catalogs: string[] }>(ro, "list_catalogs");
    assert.ok(catalogs.catalogs.includes("memory"), JSON.stringify(catalogs));
    const schemas = await call(ro, "list_schemas", { catalog: "memory" });
    assert.match(textOf(schemas), /\| memory \| main \|/);
    type SchemaList = { schemas: Array<{ catalog: string; schema: string }>; hidden_system_schemas: number };
    const filtered = await ok<SchemaList>(ro, "list_schemas");
    const withSystem = await ok<SchemaList>(ro, "list_schemas", { include_system: true });
    assert.ok(filtered.schemas.every((s) => !/^(pg_|information_schema)/.test(s.schema)), JSON.stringify(filtered));
    assert.ok(withSystem.schemas.some((s) => s.schema === "information_schema"), JSON.stringify(withSystem));
    assert.equal(withSystem.hidden_system_schemas, 0);
    assert.equal(filtered.hidden_system_schemas, withSystem.schemas.length - filtered.schemas.length);
    assert.ok(filtered.hidden_system_schemas >= 1);
    const tables = await call(ro, "list_tables", { catalog: "memory", like: "mcp%" });
    assert.match(textOf(tables), /\| memory \| main \| mcp_it \| BASE TABLE \|/);
    const described = await call(ro, "describe_table", { table: "mcp_it" });
    assert.equal(described.isError, undefined, textOf(described));
    const text = textOf(described);
    assert.match(text, /\*\*memory\.main\.mcp_it\*\* \(BASE TABLE\)/);
    assert.match(text, /\| amount \| DECIMAL\(10,2\) \| YES \|/);
    assert.match(text, /\| name \| VARCHAR \| NO \|/);
    assert.match(text, /PRIMARY KEY/);
    const est = (described.structuredContent as { estimated_rows: number | null }).estimated_rows;
    assert.notEqual(est, 0, "a populated table must not report 0 estimated rows");
    const meta = (described as { _meta?: { hardcharger_mcp?: { name: string; version: string } } })._meta;
    assert.equal(meta?.hardcharger_mcp?.name, "@gizmodata/hardcharger-mcp");
    assert.match(meta?.hardcharger_mcp?.version ?? "", /^\d+\.\d+\.\d+/);
    await failsWith(ro, "describe_table", { table: "does_not_exist" }, /Table "does_not_exist" not found/);
  });

  it("run_query enforces max_rows, truncates cells and returns structured rows", async () => {
    const r = await call(ro, "run_query", { sql: "SELECT id, name, amount, seen_at FROM mcp_it ORDER BY id" });
    assert.equal(r.isError, undefined, textOf(r));
    const s = r.structuredContent as { rows: unknown[][]; row_count: number; truncated: boolean };
    assert.equal(s.row_count, 5);
    assert.equal(s.truncated, true);
    assert.deepEqual(s.rows[0], [0, "name-0 with a long suffix", "0.00", "2024-01-02T03:04:05"]);
    const text = textOf(r);
    assert.match(text, /\| name-0 wit… \|/); // 10 chars + ellipsis
    assert.match(text, /5 rows returned \(truncated: more rows exist beyond max_rows=5\)/);

    const smaller = await ok<{ row_count: number }>(ro, "run_query", { sql: "SELECT id FROM mcp_it ORDER BY id", max_rows: 2 });
    assert.equal(smaller.row_count, 2);
    const capped = await ok<{ row_count: number }>(ro, "run_query", { sql: "SELECT id FROM mcp_it ORDER BY id", max_rows: 1000 });
    assert.equal(capped.row_count, 5);
    // A cap on an unwrappable read is enforced on the stream.
    const big = await ok<{ row_count: number; truncated: boolean }>(ro, "run_query", { sql: "FROM range(10000000)" });
    assert.equal(big.row_count, 5);
    assert.equal(big.truncated, true);
  });

  it("run_query binds parameters, typing date strings by their use", async () => {
    const r = await ok<{ rows: unknown[][] }>(ro, "run_query", {
      sql: "SELECT id, name FROM mcp_it WHERE id = ? AND seen_at < ? AND name <> ?",
      params: [100, "2030-01-01T00:00:00Z", { type: "string", value: "2024-01-02" }],
    });
    assert.deepEqual(r.rows, [[100, "bound"]]);
    const untyped = await ok<{ rows: unknown[][] }>(ro, "run_query", { sql: "SELECT ?::INTEGER + 1 AS n", params: [41] });
    assert.deepEqual(untyped.rows, [[42]]);
    const big = await ok<{ rows: unknown[][] }>(ro, "run_query", {
      sql: "SELECT ?::BIGINT AS n",
      params: [{ type: "bigint", value: "9223372036854775807" }],
    });
    assert.deepEqual(big.rows, [["9223372036854775807"]], "beyond 2^53 a bigint is rendered as a string, exactly");
    const date = await ok<{ rows: unknown[][]; columns: Array<{ type: string }> }>(ro, "run_query", {
      sql: "SELECT ? AS d",
      params: [{ type: "date", value: "2024-01-02" }],
    });
    assert.deepEqual(date.rows, [["2024-01-02"]]);
    assert.match(date.columns[0]!.type, /Date/);
  });

  it("run_query rejects writes and multiple statements before sending them", async () => {
    await failsWith(ro, "run_query", { sql: "DELETE FROM mcp_it" }, /read-only/);
    await failsWith(ro, "run_query", { sql: "WITH x AS (SELECT 1) INSERT INTO mcp_it SELECT 1, 'x', 1, NULL, NULL, NULL" }, /not allowed|read-only/);
    await failsWith(ro, "run_query", { sql: "SELECT 1; SELECT 2" }, /Only one SQL statement/);
    const count = await ok<{ rows: unknown[][] }>(ro, "run_query", { sql: "SELECT count(*) AS n FROM mcp_it" });
    assert.deepEqual(count.rows, [[22]], "nothing was deleted");
  });

  it("run_query handles unwrappable reads (PRAGMA / SHOW / DESCRIBE)", async () => {
    await ok(ro, "run_query", { sql: "PRAGMA version" });
    assert.match(textOf(await call(ro, "run_query", { sql: "SHOW TABLES" })), /mcp_it/);
    assert.match(textOf(await call(ro, "run_query", { sql: "DESCRIBE mcp_it" })), /amount/);
  });

  it("explain_query returns a plan without running the statement", async () => {
    const r = await call(ro, "explain_query", { sql: "SELECT count(*) FROM mcp_it WHERE id > 3;" });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /physical_plan/);
    const plan = r.structuredContent as { physical_plan: string | null; sections: Array<{ key: string; plan: string }> };
    assert.match(plan.physical_plan ?? "", /SCAN|AGGREGATE|FILTER/i);
    assert.ok(plan.sections.some((s) => s.key === "physical_plan"));
  });

  it("cancels a runaway query on the server at the timeout (statement_timeout) and recovers", async () => {
    const started = Date.now();
    const text = await failsWith(ro, "run_query", { sql: "SELECT count(*) FROM range(100000000000)" }, "statement_timeout");
    assert.match(text, /2s timeout/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 6000, `the server cancelled it, not the client's backstop (${elapsed}ms)`);
    await ok(ro, "run_query", { sql: "SELECT 1 AS ok" });
  });

  it("serves table DDL as a resource", async () => {
    const listed = await ro.listResources();
    const entry = listed.resources.find((r) => r.uri === "hardcharger://default/schema/memory/main/mcp_it");
    assert.ok(entry, JSON.stringify(listed.resources.map((r) => r.uri)));
    assert.equal(entry.title, "memory.main.mcp_it");
    assert.equal(entry.name, "memory.main.mcp_it");
    const read = await ro.readResource({ uri: "hardcharger://default/schema/memory/main/mcp_it" });
    assert.match((read.contents[0] as { text: string }).text, /CREATE TABLE mcp_it/);
  });

  it("serves Streamable HTTP with bearer auth: 401 without the token", async () => {
    const child = spawn(process.execPath, ["dist/cli.js", "--transport", "http", "--port", "0"], {
      env: mcpEnv({ ...passwordSettings(server), HARDCHARGER_MCP_BEARER_TOKEN: "test-token" }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error(`http server did not start: ${buf}`)), 20000);
        child.stderr.on("data", (d: Buffer) => {
          buf += d.toString();
          const m = /listening on (http:\/\/[^ ]+\/mcp)/.exec(buf);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]!);
          }
        });
        child.on("exit", (code) => reject(new Error(`server exited (${code}): ${buf}`)));
      });
      const initialize = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      };
      const unauthorized = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(initialize),
      });
      assert.equal(unauthorized.status, 401);
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: "Bearer test-token" } },
      });
      const client = new McpClient({ name: "http-test", version: "0.0.0" });
      await client.connect(transport);
      const r = await ok<{ rows: unknown[][] }>(client, "run_query", { sql: "SELECT 7 AS seven" });
      assert.deepEqual(r.rows, [[7]]);
      await client.close();
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("applies a default catalog/schema, allows USE in read-only mode, and warns on a bad default", async () => {
    const admin = await adminConnection(server);
    await admin.execute("CREATE SCHEMA IF NOT EXISTS mcp_alt");
    await admin.close();
    const withDefault = await stdioClient({
      ...passwordSettings(server),
      HARDCHARGER_DEFAULT_CATALOG: "memory",
      HARDCHARGER_DEFAULT_SCHEMA: "main",
    });
    try {
      const s = await ok<{ default_catalog: string; default_schema: string; current_catalog: string; current_schema: string; session_warnings: string[] }>(
        withDefault,
        "server_info",
      );
      assert.equal(s.default_catalog, "memory");
      assert.equal(s.default_schema, "main");
      assert.equal(s.current_catalog, "memory");
      assert.equal(s.current_schema, "main");
      assert.deepEqual(s.session_warnings, []);

      const used = await ok<{ catalog: string; schema: string }>(withDefault, "use_schema", { catalog: "memory", schema: "mcp_alt" });
      assert.equal(used.catalog, "memory");
      assert.equal(used.schema, "mcp_alt");
      await ok(withDefault, "run_query", { sql: "USE memory.main" });
      const after = await ok<{ rows: unknown[][] }>(withDefault, "run_query", { sql: "SELECT current_catalog() AS c, current_schema() AS s" });
      assert.deepEqual(after.rows, [["memory", "main"]]);
      await failsWith(withDefault, "use_schema", { catalog: "no_such_catalog" }, "invalid_option_value");
    } finally {
      await withDefault.close();
    }

    const badDefault = await stdioClient({ ...passwordSettings(server), HARDCHARGER_DEFAULT_CATALOG: "no_such_catalog" });
    try {
      const s = await ok<{ session_warnings: string[]; current_catalog: string }>(badDefault, "server_info");
      assert.equal(s.session_warnings.length, 1);
      assert.match(s.session_warnings[0]!, /Default catalog\/schema could not be applied/);
      assert.match(s.session_warnings[0]!, /Available catalogs: .*memory/);
      assert.match(s.session_warnings[0]!, /invalid_option_value/);
      assert.equal(s.current_catalog, "memory");
    } finally {
      await badDefault.close();
    }
  });

  it("supports several named connections with per-call and default switching", async () => {
    const pw = passwordSettings(server);
    const multi = await stdioClient({
      ...pw,
      HARDCHARGER_CONNECTION_NAME: "primary",
      HARDCHARGER_2_URI: server.uri,
      HARDCHARGER_2_USERNAME: adminUsername,
      HARDCHARGER_2_PASSWORD: server.password,
      HARDCHARGER_2_NAME: "alt",
      HARDCHARGER_2_DEFAULT_SCHEMA: "mcp_alt",
      HARDCHARGER_CONNECTIONS: "third",
      HARDCHARGER_THIRD_URI: server.uri,
      HARDCHARGER_THIRD_USERNAME: adminUsername,
      HARDCHARGER_THIRD_PASSWORD: server.password,
    });
    try {
      const listed = await call(multi, "list_connections");
      const s = listed.structuredContent as { current: string; connections: Array<{ name: string; uri: string; default_schema: string | null }> };
      assert.equal(s.current, "primary");
      assert.deepEqual(s.connections.map((c) => c.name), ["primary", "alt", "third"]);
      assert.equal(s.connections[1]!.default_schema, "mcp_alt");
      assert.equal(s.connections[1]!.uri, server.uri);
      assert.ok(!textOf(listed).includes(server.password));

      const onAlt = await ok<{ rows: unknown[][]; connection: string }>(multi, "run_query", { sql: "SELECT current_schema() AS s", connection: "alt" });
      assert.deepEqual(onAlt.rows, [["mcp_alt"]]);
      assert.equal(onAlt.connection, "alt");
      const onPrimary = await ok<{ rows: unknown[][] }>(multi, "run_query", { sql: "SELECT current_schema() AS s" });
      assert.deepEqual(onPrimary.rows, [["main"]]);

      const switched = await ok<{ current: string }>(multi, "use_connection", { name: "ALT" });
      assert.equal(switched.current, "alt");
      const afterSwitch = await ok<{ rows: unknown[][] }>(multi, "run_query", { sql: "SELECT current_schema() AS s" });
      assert.deepEqual(afterSwitch.rows, [["mcp_alt"]]);
      const info = await call(multi, "server_info");
      assert.equal((info.structuredContent as { connection: string }).connection, "alt");
      assert.equal((info.structuredContent as { current_connection: string }).current_connection, "alt");
      assert.match(textOf(info), /connections: primary \(hardcharger:\/\/.*\); alt \(.*\) \[current\]; third/);

      await failsWith(multi, "run_query", { sql: "SELECT 1", connection: "nope" }, /Unknown connection "nope"\. Available connections: primary, alt, third/);

      const resources = (await multi.listResources()).resources;
      const mine = resources.find((r) => r.uri === "hardcharger://third/schema/memory/main/mcp_it");
      assert.ok(mine);
      assert.equal(mine.title, "third: memory.main.mcp_it");
      const ddl = await multi.readResource({ uri: "hardcharger://third/schema/memory/main/mcp_it" });
      assert.match((ddl.contents[0] as { text: string }).text, /CREATE TABLE mcp_it/);
    } finally {
      await multi.close();
    }
  });

  it("cleans up", async () => {
    await ok(rw, "execute_statement", { sql: "DROP TABLE mcp_it" });
    await ok(rw, "execute_statement", { sql: "DROP SCHEMA IF EXISTS mcp_alt" });
  });
});
