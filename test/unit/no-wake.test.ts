// Listing, describing and tidying up must never sign in to a server or open a session there:
// a sign-in starts a GizmoData Cloud cluster that was stopped while idle (auto-resume). Only a
// query or statement against a server may start it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { connect as hardchargerConnect } from "@gizmodata/hardcharger";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { HardchargerConnection, parseConfig } from "../../dist/connection.js";
import { ConnectionRegistry } from "../../dist/registry.js";
import { NOT_CONNECTED, createServer } from "../../dist/server.js";
import { SessionStore } from "../../dist/sessions.js";

const ENV = {
  HARDCHARGER_CONNECTIONS: "a,b",
  HARDCHARGER_A_URI: "hardcharger://a.test.invalid",
  HARDCHARGER_A_USERNAME: "u",
  HARDCHARGER_A_PASSWORD: "unit-test-secret",
  HARDCHARGER_B_URI: "hardcharger://b.test.invalid",
  HARDCHARGER_B_USERNAME: "u",
  HARDCHARGER_B_PASSWORD: "unit-test-secret",
};

/** A registry whose connections count every attempt to open a client (and never open one). */
function countingRegistry(): { registry: ConnectionRegistry; opened: string[] } {
  const config = parseConfig(ENV);
  const registry = new ConnectionRegistry(config, () => undefined);
  const opened: string[] = [];
  for (const c of registry.all()) {
    c.get = async () => {
      opened.push(c.config.name);
      throw new Error(`test: ${c.config.name} must not be connected`);
    };
  }
  return { registry, opened };
}

async function withClient(registry: ConnectionRegistry, fn: (client: Client) => Promise<void>): Promise<void> {
  const config = registry.config;
  const server = createServer({ registry, config, transport: "stdio" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("listing never connects to a server", () => {
  it("list_connections and server_info connect to nothing not in use", async () => {
    const { registry, opened } = countingRegistry();
    await withClient(registry, async (client) => {
      const listed = await client.callTool({ name: "list_connections", arguments: {} });
      assert.equal(listed.isError, undefined);
      const info = await client.callTool({ name: "server_info", arguments: { connection: "b" } });
      assert.equal(info.isError, undefined, JSON.stringify(info.content));
      const s = info.structuredContent as Record<string, unknown>;
      assert.equal(s.hardcharger_version, NOT_CONNECTED);
      assert.equal(s.user, NOT_CONNECTED);
      assert.equal(s.hardcharger_session_idle_timeout_seconds, null);
      assert.equal(s.connection_uri, "hardcharger://b.test.invalid");
    });
    assert.deepEqual(opened, []);
  });

  it("the table resource list connects to nothing not in use", async () => {
    const { registry, opened } = countingRegistry();
    await withClient(registry, async (client) => {
      const { resources } = await client.listResources();
      assert.deepEqual(resources, []);
    });
    assert.deepEqual(opened, []);
  });
});

// A fake Chargewire server behind fetch, with short-lived tokens, counting sign-ins.
function fakeServer() {
  let tokens = 0;
  const seen: Array<{ method: string; path: string; auth: string | null }> = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    seen.push({ method, path: url.pathname, auth: new Headers(init?.headers).get("authorization") });
    if (url.pathname === "/chargewire") {
      return json(200, { protocol: "chargewire", protocol_versions: ["1"], capabilities: [], auth: { grant_types: ["password"] } });
    }
    if (url.pathname.endsWith("/auth/token")) {
      return json(200, { access_token: `t${++tokens}`, token_type: "Bearer", expires_in: 1 });
    }
    if (method === "POST" && url.pathname.endsWith("/sessions")) {
      return json(201, { session_id: "s1", options: {}, transaction: "none", idle_timeout_s: 900 });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    // The settings probe at connect: refused, which the connection tolerates.
    return json(400, { status: 400, code: "invalid_argument", detail: "fake" });
  }) as typeof fetch;
  return { fetchImpl, seen, signIns: () => tokens };
}

describe("closing an idle session never signs in", () => {
  it("an idle eviction late in the token's life sends only the DELETE, with that token", async () => {
    const server = fakeServer();
    const config = parseConfig(ENV);
    const conn = new HardchargerConnection(config.connections[0]!, () => undefined, {
      connect: (options) => hardchargerConnect({ ...options, fetch: server.fetchImpl }),
    });
    let now = 1_000_000;
    const store = new SessionStore(config, {
      idleSeconds: 1800,
      maxSessions: 10,
      sweepIntervalMs: 0,
      now: () => now,
      log: () => undefined,
      createRegistry: () => {
        const registry = new ConnectionRegistry(config, () => undefined);
        registry.all = () => [conn];
        return registry;
      },
    });
    store.acquire("person", "person");
    await conn.get(); // the person ran something: signed in, session open
    assert.equal(server.signIns(), 1);
    await new Promise((r) => setTimeout(r, 800)); // past three quarters of the token's life
    now += 1801 * 1000;
    await store.sweep();
    assert.equal(store.size(), 0);
    assert.equal(server.signIns(), 1, JSON.stringify(server.seen));
    const deletes = server.seen.filter((s) => s.method === "DELETE");
    assert.deepEqual(deletes, [{ method: "DELETE", path: "/chargewire/v1/sessions/s1", auth: "Bearer t1" }]);
    await store.close();
  });
});

// A stand-in for a stopped server (GizmoData Cloud's resume holder): discovery says "stopped".
function stoppedServer(options: { password?: "wrong" } = {}) {
  let tokens = 0;
  const seen: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : "";
    seen.push(`${method} ${url.pathname}${method === "PATCH" ? ` ${body}` : ""}`);
    if (url.pathname === "/chargewire") {
      return json(200, {
        protocol: "chargewire",
        protocol_versions: ["1"],
        capabilities: [],
        auth: { grant_types: ["password"] },
        state: "stopped",
      });
    }
    if (url.pathname.endsWith("/auth/token")) {
      if (options.password === "wrong") return json(401, { status: 401, code: "invalid_credentials", detail: "fake" });
      return json(200, { access_token: `t${++tokens}`, token_type: "Bearer", expires_in: 3600 });
    }
    if (method === "POST" && url.pathname.endsWith("/sessions")) {
      return json(201, { session_id: "s1", options: {}, transaction: "none", idle_timeout_s: 900 });
    }
    if (method === "PATCH") return json(200, { options: (JSON.parse(body) as { options: unknown }).options });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/statements") && body.includes("AS answer")) {
      return json(200, { statement_id: "q1", state: "succeeded", result: { kind: "update", rows_affected: 0 } });
    }
    // The server-settings probe: refused, which the connection tolerates once signed in.
    return json(400, { status: 400, code: "invalid_argument", detail: "fake" });
  }) as typeof fetch;
  return { fetchImpl, seen, signIns: () => seen.filter((s) => s.endsWith("/auth/token")).length };
}

const STOPPED_ENV = {
  HARDCHARGER_URI: "hardcharger://stopped.test.invalid",
  HARDCHARGER_USERNAME: "u",
  HARDCHARGER_PASSWORD: "unit-test-secret",
  HARDCHARGER_DEFAULT_CATALOG: "lake",
  HARDCHARGER_DEFAULT_SCHEMA: "main",
};

describe("a stopped cluster (lazy connect)", () => {
  it("connecting sends only discovery; the first query signs in, opens the session, applies the setup, then runs", async () => {
    const server = stoppedServer();
    const config = parseConfig(STOPPED_ENV);
    let atConnect: string[] = [];
    const conn = new HardchargerConnection(config.connections[0]!, () => undefined, {
      connect: async (options) => {
        const client = await hardchargerConnect({ ...options, fetch: server.fetchImpl });
        atConnect = [...server.seen];
        return client;
      },
    });
    await conn.run((c) => c.execute("SELECT 42 AS answer"));
    assert.deepEqual(atConnect, ["GET /chargewire"]);
    assert.deepEqual(server.seen.slice(0, 6), [
      "GET /chargewire",
      "POST /chargewire/v1/auth/token",
      "POST /chargewire/v1/sessions",
      'PATCH /chargewire/v1/sessions/s1 {"options":{"catalog":"lake","schema":"main"}}',
      "POST /chargewire/v1/sessions/s1/statements", // the server-settings probe
      "POST /chargewire/v1/sessions/s1/statements", // the query
    ]);
    assert.deepEqual(conn.sessionWarnings(), []);
    await conn.close();
  });

  it("a wrong password is the first query's error, from one sign-in, not a setup warning", async () => {
    const server = stoppedServer({ password: "wrong" });
    const config = parseConfig(STOPPED_ENV);
    const conn = new HardchargerConnection(config.connections[0]!, () => undefined, {
      connect: (options) => hardchargerConnect({ ...options, fetch: server.fetchImpl }),
    });
    await assert.rejects(conn.run((c) => c.execute("SELECT 42 AS answer")), (e: unknown) => (e as { code?: string }).code === "invalid_credentials");
    assert.equal(server.signIns(), 1, server.seen.join("\n"));
    assert.deepEqual(conn.sessionWarnings(), []);
    assert.equal(conn.connectedAt, null);
    await conn.close();
  });
});
