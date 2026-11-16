// Integration tests for the connection broker: every statement runs as the signed-in person.
//
// A real hardcharger-server runs with access control (a DuckDB-file store), trusts sign-in tokens
// signed by a throwaway key, and provisions a store user on a trusted token's first sign-in. A
// fake broker plays the control plane: it accepts only this MCP server's credential, checks each
// caller's OAuth access token (opaque, as Clerk's are: only the broker can say whose it is, through
// /introspect), decides which servers that person may reach, and mints their sign-in tokens. The
// MCP server runs in-process (startHttp) with no Hardcharger or identity-provider credentials.

import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomBytes } from "node:crypto";

import { SignJWT, exportSPKI, generateKeyPair } from "jose";

import { parseConfig } from "../../dist/connection.js";
import { startHttp } from "../../dist/transports.js";
import { FakeIssuer } from "../helpers/fake-issuer.ts";
import { type RunningServer, adminConnection, call, launchServer, ok, sleep, textOf } from "./harness.ts";

const PUBLIC_URL = "https://mcp.test.invalid/mcp";
const AUDIENCE = "api://hardcharger-mcp-test";
const BROKER_CREDENTIAL = "broker-credential-for-the-mcp-server";
const CLUSTER_ISSUER = "https://control-plane.test.invalid";
const CLUSTER_AUDIENCE = "cluster-under-test";
/** Lifetime of the sign-in tokens the fake broker mints (and of the server's access tokens). */
const TOKEN_SECONDS = 3;

interface Grant {
  /** Connection names this person may reach, mapped to whether writes are allowed there. */
  servers: Record<string, boolean>;
  groups?: string[];
  /** The broker's `read_only` per connection name; a name not here is listed without the field. */
  readOnly?: Record<string, boolean | null>;
  /** Connection names dialled through the gated TCP proxy (a server slow to answer). */
  proxied?: string[];
}

describe("connection broker: per-person identity", () => {
  let target: RunningServer;
  const idp = new FakeIssuer();
  const home = mkdtempSync(join(tmpdir(), "hardcharger-mcp-broker-"));
  let brokerServer: http.Server;
  let brokerUrl = "";
  let mcpServer: http.Server;
  let mcpUrl = "";
  const clients: Client[] = [];
  let signingKey: CryptoKey;
  /** Who may reach what: the broker's access table, edited by the tests. */
  const access = new Map<string, Grant>();
  /** Sign-in tokens minted, per person. */
  const mints = new Map<string, number>();
  /** Every request the broker refused, with why. */
  const refusals: string[] = [];
  /** Opaque access tokens the "provider" issued, and whose they are. */
  const accessTokens = new Map<string, string>();
  /** Introspections the broker answered. */
  let introspections = 0;
  /** When set, the broker answers every request with this status (an outage). */
  let outage: number | undefined;
  /** A TCP proxy to the server that holds each new connection until `gate` resolves. */
  let proxy: net.Server;
  let proxyPort = 0;
  let gate: Promise<void> = Promise.resolve();
  let proxyConnections = 0;

  async function startBroker(): Promise<void> {
    brokerServer = http.createServer(async (req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      if (outage !== undefined) return reply(outage, { detail: "down for maintenance" });
      if (req.headers.authorization !== `Bearer ${BROKER_CREDENTIAL}`) {
        refusals.push("credential");
        return reply(401, { detail: "unknown MCP server" });
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { subject_token?: string };
      const url = new URL(req.url ?? "/", "http://localhost");
      const owner = accessTokens.get(body.subject_token ?? "");
      if (req.method === "POST" && url.pathname === "/broker/introspect") {
        introspections++;
        return reply(200, owner ? { active: true, sub: `sub-${owner}`, email: owner } : { active: false });
      }
      if (owner === undefined) {
        refusals.push("subject token");
        return reply(401, { detail: "Your sign-in is not valid; reconnect." });
      }
      const email = owner;
      const grant = access.get(email) ?? { servers: {} };
      if (req.method === "POST" && url.pathname === "/broker/connections") {
        return reply(200, {
          connections: Object.entries(grant.servers).map(([name, allowWrites]) => ({
            id: `id-${name}`,
            name,
            label: `Test org / ${name}`,
            uri: grant.proxied?.includes(name) ? `hardcharger://127.0.0.1:${proxyPort}?tls=false` : target.uri,
            default_catalog: "memory",
            default_schema: "main",
            allow_writes: allowWrites,
            ...(grant.readOnly && name in grant.readOnly ? { read_only: grant.readOnly[name] } : {}),
          })),
          message: "You have no servers yet.",
        });
      }
      const m = /^\/broker\/connections\/id-([^/]+)\/token$/u.exec(url.pathname);
      if (req.method === "POST" && m) {
        if (!(m[1] in grant.servers)) {
          refusals.push(`token ${email} ${m[1]}`);
          return reply(403, { detail: `You don't have access to ${m[1]}.` });
        }
        mints.set(email, (mints.get(email) ?? 0) + 1);
        const token = await new SignJWT({ role: "user", groups: grant.groups ?? [] })
          .setProtectedHeader({ alg: "RS256" })
          .setIssuer(CLUSTER_ISSUER)
          .setAudience(CLUSTER_AUDIENCE)
          .setSubject(email)
          .setIssuedAt()
          .setExpirationTime(`${TOKEN_SECONDS}s`)
          .sign(signingKey);
        return reply(200, { token, expires_in: TOKEN_SECONDS });
      }
      reply(404, { detail: "not found" });
    });
    await new Promise<void>((resolve) => brokerServer.listen(0, "127.0.0.1", () => resolve()));
    brokerUrl = `http://127.0.0.1:${(brokerServer.address() as { port: number }).port}/broker`;
  }

  /** An MCP client signed in as `email`, with an opaque access token only the broker can read. */
  async function connectAs(email: string): Promise<Client> {
    const token = `oat_${randomBytes(16).toString("hex")}`;
    accessTokens.set(token, email);
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: `broker-${email}`, version: "0.0.0" });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  before(async () => {
    const keys = await generateKeyPair("RS256");
    signingKey = keys.privateKey;
    const verifyKey = join(home, "verify.pem");
    writeFileSync(verifyKey, await exportSPKI(keys.publicKey));
    target = await launchServer({
      args: [
        "--rbac-store-uri",
        `duckdb:${join(home, "rbac.duckdb")}`,
        "--token-signature-verify-cert-path",
        verifyKey,
        "--token-allowed-issuer",
        CLUSTER_ISSUER,
        "--token-allowed-audience",
        CLUSTER_AUDIENCE,
        "--token-auto-provision-users",
        "--token-groups-claim",
        "groups",
        "--token-lifetime-seconds",
        String(TOKEN_SECONDS),
      ],
    });
    await idp.start();
    await startBroker();
    proxy = net.createServer((client) => {
      proxyConnections++;
      client.pause();
      client.on("error", () => undefined);
      void gate.then(() => {
        const upstream = net.connect({ host: "127.0.0.1", port: target.port });
        client.pipe(upstream);
        upstream.pipe(client);
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        client.resume();
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    proxyPort = (proxy.address() as net.AddressInfo).port;

    const admin = await adminConnection(target);
    try {
      for (const sql of [
        "CREATE TABLE memory.main.orders AS SELECT * FROM (VALUES (1, 'depot-a'), (2, 'depot-b')) t(id, depot)",
        "CREATE ROLE analyst",
        "GRANT SELECT ON main.orders TO analyst",
        "CREATE SCHEMA memory.staging",
        "CREATE TABLE memory.staging.orders AS SELECT * FROM (VALUES (1, 'staging-x')) t(id, depot)",
        "CREATE ROLE fixer",
        "GRANT SELECT, UPDATE ON main.orders TO fixer",
        "GRANT SELECT, UPDATE ON staging.orders TO fixer",
        // Set up before carol has ever signed in.
        'CREATE USER "carol@example.com"',
        'GRANT analyst TO "carol@example.com"',
        'CREATE USER "frank@example.com"',
        'GRANT fixer TO "frank@example.com"',
        // Everyone the control plane calls a writer reads orders, whoever they are.
        `CREATE GROUP MAPPING 'cloud:writer' ISSUER '${CLUSTER_ISSUER}' TO ROLE analyst`,
      ]) {
        await admin.execute(sql);
      }
    } finally {
      await admin.close();
    }

    const config = parseConfig({
      HARDCHARGER_MCP_PUBLIC_URL: PUBLIC_URL,
      HARDCHARGER_MCP_OAUTH_ISSUER: idp.issuer,
      HARDCHARGER_MCP_OAUTH_AUDIENCE: AUDIENCE,
      HARDCHARGER_MCP_OAUTH_ALLOW_INSECURE: "true",
      HARDCHARGER_MCP_BROKER_URL: brokerUrl,
      HARDCHARGER_MCP_BROKER_TOKEN: BROKER_CREDENTIAL,
      HARDCHARGER_MCP_BROKER_ALLOW_INSECURE: "true",
      HARDCHARGER_MCP_BROKER_CACHE_SECONDS: "0",
      HARDCHARGER_ALLOW_WRITES: "true",
    });
    mcpServer = await startHttp(config, { host: "127.0.0.1", port: 0, installSignalHandlers: false });
    mcpUrl = `http://127.0.0.1:${(mcpServer.address() as { port: number }).port}/mcp`;
  });

  after(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await new Promise<void>((resolve) => mcpServer?.close(() => resolve()));
    await new Promise<void>((resolve) => brokerServer?.close(() => resolve()));
    await new Promise<void>((resolve) => proxy?.close(() => resolve()));
    await idp.stop();
    await target?.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const whoAmI = async (client: Client, connection?: string) => {
    // server_info never connects: a query does.
    await ok(client, "run_query", connection ? { sql: "SELECT 1", connection } : { sql: "SELECT 1" });
    const info = await ok<{ user: string; auth_method: string; authenticated_user: string }>(
      client,
      "server_info",
      connection ? { connection } : {},
    );
    return info;
  };

  it("runs each person's statements as that person, signed in by the broker's token", async () => {
    access.set("alice@example.com", { servers: { analytics: false } });
    access.set("bob@example.com", { servers: { analytics: false } });
    const alice = await connectAs("alice@example.com");
    const bob = await connectAs("bob@example.com");
    const [a, b] = await Promise.all([whoAmI(alice), whoAmI(bob)]);
    assert.equal(a.user, "alice@example.com");
    assert.equal(a.auth_method, "brokered");
    assert.equal(a.authenticated_user, "alice@example.com");
    assert.equal(b.user, "bob@example.com");
    assert.equal(refusals.length, 0, refusals.join(", "));
  });

  it("enforces the server's grants: a user set up before signing in reads; a new user reads nothing", async () => {
    access.set("carol@example.com", { servers: { analytics: false } });
    access.set("dave@example.com", { servers: { analytics: false } });
    const carol = await connectAs("carol@example.com");
    const rows = await ok<{ rows: unknown[][] }>(carol, "run_query", { sql: "SELECT id, depot FROM orders ORDER BY id" });
    assert.deepEqual(rows.rows, [[1, "depot-a"], [2, "depot-b"]]);

    const dave = await connectAs("dave@example.com");
    const refused = await call(dave, "run_query", { sql: "SELECT id FROM orders" });
    assert.equal(refused.isError, true);
    // Refused by the server's access control (dave was provisioned with no grants), not by anything here.
    assert.match(textOf(refused), /dave@example\.com/u);
    assert.match(textOf(refused), /permission_denied|Permission Error/u);
  });

  it("maps the broker's groups to roles (CREATE GROUP MAPPING) for a user nobody set up", async () => {
    access.set("erin@example.com", { servers: { analytics: false }, groups: ["cloud:writer"] });
    const erin = await connectAs("erin@example.com");
    const rows = await ok<{ rows: unknown[][] }>(erin, "run_query", { sql: "SELECT count(*) FROM orders" });
    assert.equal(Number(rows.rows[0][0]), 2);
  });

  it("lets a granted person fix data where the broker allows writes, and refuses everyone else", async () => {
    access.set("frank@example.com", { servers: { analytics: true, readonly_view: false } });
    access.set("carol@example.com", { servers: { analytics: true } });
    const frank = await connectAs("frank@example.com");
    const listed = await ok<{ connections: Array<{ name: string; allow_writes: boolean }> }>(frank, "list_connections");
    assert.deepEqual(
      listed.connections.map((c) => [c.name, c.allow_writes]),
      [
        ["analytics", true],
        ["readonly_view", false],
      ],
    );

    const fixed = await ok<{ affected_rows: number }>(frank, "execute_statement", {
      sql: "UPDATE orders SET depot = ? WHERE id = ?",
      params: ["depot-c", 2],
      connection: "analytics",
    });
    assert.equal(fixed.affected_rows, 1);
    const admin = await adminConnection(target);
    try {
      const t = await admin.query("SELECT depot FROM memory.main.orders WHERE id = 2");
      assert.equal(t.getChildAt(0)?.get(0), "depot-c");
    } finally {
      await admin.close();
    }

    // The broker said no writes on this connection: refused here, before the server.
    const blocked = await call(frank, "execute_statement", { sql: "UPDATE orders SET depot = 'x'", connection: "readonly_view" });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /does not accept writes/u);

    // Writes allowed on the connection, but carol holds SELECT only: the server refuses.
    const carol = await connectAs("carol@example.com");
    const denied = await call(carol, "execute_statement", { sql: "UPDATE orders SET depot = 'x' WHERE id = 1", connection: "analytics" });
    assert.equal(denied.isError, true);
    assert.match(textOf(denied), /carol@example\.com/u);
    assert.match(textOf(denied), /permission_denied|Permission Error/u);
  });

  it("shows only the servers the broker lists, and closes one when access is withdrawn", async () => {
    access.set("grace@example.com", { servers: { analytics: false, finance: false } });
    access.set("heidi@example.com", { servers: { analytics: false } });
    const heidi = await connectAs("heidi@example.com");
    const other = await call(heidi, "run_query", { sql: "SELECT 1", connection: "finance" });
    assert.equal(other.isError, true);
    assert.match(textOf(other), /Unknown connection "finance"/u);

    const grace = await connectAs("grace@example.com");
    assert.equal((await whoAmI(grace, "finance")).user, "grace@example.com");
    access.set("grace@example.com", { servers: { analytics: false } });
    await ok(grace, "list_connections");
    const gone = await call(grace, "run_query", { sql: "SELECT 1", connection: "finance" });
    assert.equal(gone.isError, true);
    assert.match(textOf(gone), /Unknown connection "finance"/u);

    // Nothing left at all: the broker's own message.
    access.set("grace@example.com", { servers: {} });
    const none = await call(grace, "list_connections");
    assert.match(textOf(none), /You have no servers yet\./u);
    const nothing = await call(grace, "run_query", { sql: "SELECT 1" });
    assert.equal(nothing.isError, true);
    assert.match(textOf(nothing), /You have no servers yet\./u);
  });

  it("lets the broker require a server-enforced read-only session per connection, and replaces the session when that changes", async () => {
    const admin = await adminConnection(target);
    try {
      await admin.execute('CREATE USER "kate@example.com"');
      await admin.execute('GRANT fixer TO "kate@example.com"');
    } finally {
      await admin.close();
    }
    // Writes allowed by the broker on both; "guarded" also requires a read-only session, "plain" says nothing.
    access.set("kate@example.com", { servers: { guarded: true, plain: true }, readOnly: { guarded: true } });
    const kate = await connectAs("kate@example.com");
    const listed = await ok<{ connections: Array<{ name: string; read_only_required: boolean; allow_writes: boolean }> }>(kate, "list_connections");
    assert.deepEqual(
      listed.connections.map((c) => [c.name, c.read_only_required, c.allow_writes]),
      [
        ["guarded", true, false],
        ["plain", false, true],
      ],
    );
    const blocked = await call(kate, "execute_statement", { sql: "UPDATE orders SET depot = 'x' WHERE id = 1", connection: "guarded" });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /does not accept writes/u);
    // This SELECT passes the MCP server's SQL check. A read-only session refuses it with the server's
    // own read_only code (SQLSTATE 25006) before anything else; any other session refuses it only
    // because kate isn't an administrator.
    const changeSession = "SELECT hardcharger_set_session_setting(HARDCHARGER_CURRENT_SESSION(), 'query_timeout', '30')";
    const readOnlyRefusal = /\(read_only, SQLSTATE 25006\b/u;
    const refusal = async (connection: string): Promise<string> => {
      const r = await call(kate, "run_query", { sql: changeSession, connection });
      assert.equal(r.isError, true, textOf(r));
      return textOf(r);
    };
    assert.match(await refusal("guarded"), readOnlyRefusal);
    const ordinary = await refusal("plain");
    assert.doesNotMatch(ordinary, readOnlyRefusal);
    assert.match(ordinary, /permission_denied/u);

    // The administrator turns AI writes on again: the read-only session is replaced with an ordinary one.
    access.set("kate@example.com", { servers: { guarded: true, plain: true }, readOnly: { guarded: false } });
    const relisted = await ok<{ connections: Array<{ name: string; read_only_required: boolean; allow_writes: boolean }> }>(kate, "list_connections");
    assert.deepEqual(relisted.connections.map((c) => [c.name, c.read_only_required, c.allow_writes])[0], ["guarded", false, true]);
    const nowOrdinary = await refusal("guarded");
    assert.doesNotMatch(nowOrdinary, readOnlyRefusal);
    assert.match(nowOrdinary, /permission_denied/u);
    const fixed = await ok<{ affected_rows: number }>(kate, "execute_statement", {
      sql: "UPDATE orders SET depot = depot WHERE id = 1",
      connection: "guarded",
    });
    assert.equal(fixed.affected_rows, 1);

    // And off: the writable session is not kept.
    access.set("kate@example.com", { servers: { guarded: true, plain: true }, readOnly: { guarded: true } });
    await ok(kate, "list_connections");
    assert.match(await refusal("guarded"), readOnlyRefusal);
  });

  it("refuses a write still connecting when the broker turns read-only on, and leaves no session open", { timeout: 60_000 }, async () => {
    const admin = await adminConnection(target);
    const rows = async (sql: string) => (await admin.query(sql)).toArray().map((r: { toJSON(): unknown }) => r.toJSON());
    const lucysSessions = async () =>
      (await rows("SELECT * FROM hardcharger_sessions()")).filter((s) => JSON.stringify(s, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v)).includes("lucy@example.com"));
    try {
      await admin.execute('CREATE USER "lucy@example.com"');
      await admin.execute('GRANT fixer TO "lucy@example.com"');
      access.set("lucy@example.com", { servers: { slow: true }, proxied: ["slow"] });
      const lucy = await connectAs("lucy@example.com");
      await ok(lucy, "list_connections");
      const before = await rows("SELECT depot FROM memory.main.orders WHERE id = 1");

      // The write passes this server's checks (writes allowed), then waits to connect: the server is
      // slow to answer (a stopped cluster resuming).
      let open!: () => void;
      gate = new Promise<void>((resolve) => (open = resolve));
      const seen = proxyConnections;
      const pending = call(lucy, "execute_statement", { sql: "UPDATE orders SET depot = 'late-write' WHERE id = 1", connection: "slow" });
      for (let i = 0; i < 100 && proxyConnections === seen; i++) await sleep(50);
      assert.ok(proxyConnections > seen, "the connection attempt is held at the proxy");

      // Meanwhile AI writes are turned off: the broker requires read-only, and lucy's next request re-lists.
      access.set("lucy@example.com", { servers: { slow: false }, readOnly: { slow: true }, proxied: ["slow"] });
      const relisted = await ok<{ connections: Array<{ name: string; read_only_required: boolean; allow_writes: boolean }> }>(lucy, "list_connections");
      assert.deepEqual(relisted.connections.map((c) => [c.name, c.read_only_required, c.allow_writes]), [["slow", true, false]]);

      open(); // the server answers
      const result = await pending;
      assert.equal(result.isError, true, textOf(result));
      assert.match(textOf(result), /was closed while this call waited or ran \(replaced: the connection now requires a read-only session\)/u);
      assert.deepEqual(await rows("SELECT depot FROM memory.main.orders WHERE id = 1"), before, "the write never ran");
      assert.deepEqual(await lucysSessions(), [], "the session opened late was closed");

      // The next call gets a server-enforced read-only session.
      const next = await call(lucy, "run_query", {
        sql: "SELECT hardcharger_set_session_setting(HARDCHARGER_CURRENT_SESSION(), 'query_timeout', '30')",
        connection: "slow",
      });
      assert.match(textOf(next), /\(read_only, SQLSTATE 25006\b/u);
      assert.equal((await lucysSessions()).length, 1, "the session list does show lucy's sessions: now the read-only one");
    } finally {
      gate = Promise.resolve();
      await admin.close();
    }
  });

  it("keeps the schema the person chose when a read_only change gives them a new session", async () => {
    const admin = await adminConnection(target);
    try {
      await admin.execute('CREATE USER "mia@example.com"');
      await admin.execute('GRANT fixer TO "mia@example.com"');
      access.set("mia@example.com", { servers: { guarded: true }, readOnly: { guarded: true } });
      const mia = await connectAs("mia@example.com");
      await ok(mia, "use_schema", { schema: "staging" });
      const read = await ok<{ rows: unknown[][] }>(mia, "run_query", { sql: "SELECT current_schema(), depot FROM orders ORDER BY id" });
      assert.deepEqual(read.rows, [["staging", "staging-x"]]);
      const main = (await admin.query("SELECT id, depot FROM memory.main.orders ORDER BY id")).toArray().map((r: { toJSON(): unknown }) => r.toJSON());

      // AI writes turned on: a new, ordinary session, still in staging.
      access.set("mia@example.com", { servers: { guarded: true }, readOnly: { guarded: false } });
      const listed = await ok<{ connections: Array<{ read_only_required: boolean; default_schema: string }> }>(mia, "list_connections");
      assert.deepEqual(listed.connections.map((c) => [c.read_only_required, c.default_schema]), [[false, "staging"]]);
      const fixed = await ok<{ affected_rows: number }>(mia, "execute_statement", { sql: "UPDATE orders SET depot = 'fixed-in-staging' WHERE id = 1" });
      assert.equal(fixed.affected_rows, 1);
      const staging = (await admin.query("SELECT id, depot FROM memory.staging.orders ORDER BY id")).toArray().map((r: { toJSON(): unknown }) => r.toJSON());
      assert.deepEqual(staging, [{ id: 1, depot: "fixed-in-staging" }]);
      const mainAfter = (await admin.query("SELECT id, depot FROM memory.main.orders ORDER BY id")).toArray().map((r: { toJSON(): unknown }) => r.toJSON());
      assert.deepEqual(mainAfter, main, "the default schema's table is untouched");
    } finally {
      await admin.close();
    }
  });

  it("signs in again with a fresh broker token when the server's access token expires", async () => {
    access.set("ivan@example.com", { servers: { analytics: false }, groups: ["cloud:writer"] });
    const ivan = await connectAs("ivan@example.com");
    await ok(ivan, "run_query", { sql: "SELECT count(*) FROM orders" });
    const before = mints.get("ivan@example.com") ?? 0;
    assert.ok(before >= 1);
    await new Promise((resolve) => setTimeout(resolve, (TOKEN_SECONDS + 2) * 1000));
    const rows = await ok<{ rows: unknown[][] }>(ivan, "run_query", { sql: "SELECT count(*) FROM orders" });
    assert.equal(Number(rows.rows[0][0]), 2);
    assert.ok((mints.get("ivan@example.com") ?? 0) > before, `minted ${mints.get("ivan@example.com")} after ${before}`);
  });

  it("checks opaque access tokens with the broker, never the provider's keys, and reuses an answer briefly", async () => {
    access.set("kim@example.com", { servers: { analytics: false } });
    const before = introspections;
    const kim = await connectAs("kim@example.com");
    await ok(kim, "list_connections");
    await ok(kim, "list_connections");
    assert.equal(introspections - before, 1, "one introspection for a burst of requests");
    assert.equal(idp.discoveryHits, 0, "no JWKS discovery in broker mode");

    const post = (token: string) =>
      fetch(mcpUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    const unknown = await post("oat_not-issued-by-anyone");
    assert.equal(unknown.status, 401);
    assert.match(unknown.headers.get("www-authenticate") ?? "", /error="invalid_token"/u);

    // The broker is down: the caller's token isn't the problem, so no 401 that would send them to sign in again.
    const fresh = `oat_${randomBytes(16).toString("hex")}`;
    accessTokens.set(fresh, "kim@example.com");
    outage = 503;
    try {
      const down = await post(fresh);
      assert.equal(down.status, 503);
      assert.equal(down.headers.get("www-authenticate"), null);
    } finally {
      outage = undefined;
    }
  });

  it("never shows a caller a token in an answer", async () => {
    access.set("judy@example.com", { servers: { analytics: false } });
    const judy = await connectAs("judy@example.com");
    const results = [await call(judy, "server_info"), await call(judy, "list_connections"), await call(judy, "run_query", { sql: "SELECT nope" })];
    for (const r of results) {
      const shown = JSON.stringify(r);
      assert.doesNotMatch(shown, /eyJ[A-Za-z0-9_-]{10,}\./u, "no JWT in a tool result");
      assert.ok(!shown.includes(BROKER_CREDENTIAL));
      for (const [token, owner] of accessTokens) {
        if (owner === "judy@example.com") assert.ok(!shown.includes(token), "no access token in a tool result");
      }
    }
  });
});
