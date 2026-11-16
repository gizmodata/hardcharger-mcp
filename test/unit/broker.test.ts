import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardchargerError } from "@gizmodata/hardcharger";
import { tableFromArrays } from "apache-arrow";

import { ACCESS_TOKEN_TYPE, BrokerClient, BrokerError, BrokeredRegistry } from "../../dist/broker.js";
import {
  ConfigError,
  ConnectionReplacedError,
  SettingsLostError,
  TransactionLostError,
  endsTransaction,
  parseConfig,
} from "../../dist/connection.js";
import { INTROSPECTION_CACHE_MS, OAuthError, OAuthVerifier } from "../../dist/oauth.js";
import { NoConnectionsError } from "../../dist/registry.js";
import { startStdio } from "../../dist/transports.js";

const OAUTH = {
  HARDCHARGER_MCP_PUBLIC_URL: "https://mcp.test.invalid/mcp",
  HARDCHARGER_MCP_OAUTH_ISSUER: "https://idp.test.invalid",
};
const BROKER = {
  HARDCHARGER_MCP_BROKER_URL: "https://broker.test.invalid/mcp-broker",
  HARDCHARGER_MCP_BROKER_TOKEN: "broker-credential-of-this-server",
};

interface Seen {
  url: string;
  authorization: string | null;
  body: { subject_token?: string; subject_token_type?: string };
}

/** A fake broker behind fetch: `answer` decides each response from the request. */
function fakeBroker(answer: (seen: Seen) => { status?: number; body?: unknown; raw?: string }) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const request: Seen = {
      url: String(input),
      authorization: headers.get("authorization"),
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    seen.push(request);
    const a = answer(request);
    return new Response(a.raw ?? JSON.stringify(a.body ?? {}), {
      status: a.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const cluster = (over: Record<string, unknown> = {}) => ({
  id: "c-1",
  name: "analytics",
  label: "Acme / Analytics / prod",
  uri: "hardcharger://analytics.test.invalid",
  allow_writes: false,
  ...over,
});

function registry(
  answer: Parameters<typeof fakeBroker>[0],
  env: Record<string, string> = {},
): { r: BrokeredRegistry; seen: Seen[]; lines: string[]; tick: (ms: number) => void } {
  const config = parseConfig({ ...OAUTH, ...BROKER, ...env });
  const { seen, fetchImpl } = fakeBroker(answer);
  let now = 1_000_000;
  const lines: string[] = [];
  const r = new BrokeredRegistry(config, new BrokerClient(config.broker!, { fetch: fetchImpl }), (m) => lines.push(m), {
    now: () => now,
  });
  r.setSubjectToken("caller-access-token");
  return { r, seen, lines, tick: (ms) => (now += ms) };
}

describe("connection broker configuration", () => {
  it("parses the broker settings and needs no configured connection", () => {
    const config = parseConfig({ ...OAUTH, ...BROKER, HARDCHARGER_MCP_BROKER_CACHE_SECONDS: "30" });
    assert.deepEqual(config.connections, []);
    assert.equal(config.broker?.url, "https://broker.test.invalid/mcp-broker");
    assert.equal(config.broker?.credential, "broker-credential-of-this-server");
    assert.equal(config.broker?.cacheSeconds, 30);
  });

  it("refuses a broker without OAuth: credentials are per signed-in user", () => {
    assert.throws(() => parseConfig({ ...BROKER }), (e: unknown) => e instanceof ConfigError && /needs HARDCHARGER_MCP_OAUTH_ISSUER/u.test(e.message));
    assert.throws(
      () => parseConfig({ ...BROKER, HARDCHARGER_MCP_BEARER_TOKEN: "static" }),
      (e: unknown) => e instanceof ConfigError && /needs HARDCHARGER_MCP_OAUTH_ISSUER/u.test(e.message),
    );
  });

  it("refuses configured connections next to a broker, so no shared credential reaches every user", () => {
    assert.throws(
      () =>
        parseConfig({
          ...OAUTH,
          ...BROKER,
          HARDCHARGER_URI: "hardcharger://db.test.invalid",
          HARDCHARGER_USERNAME: "svc",
          HARDCHARGER_PASSWORD: "pw",
        }),
      (e: unknown) => e instanceof ConfigError && /would be shared by every user/u.test(e.message),
    );
  });

  it("requires this server's own broker credential, and https unless told otherwise", () => {
    assert.throws(
      () => parseConfig({ ...OAUTH, HARDCHARGER_MCP_BROKER_URL: BROKER.HARDCHARGER_MCP_BROKER_URL }),
      (e: unknown) => e instanceof ConfigError && /HARDCHARGER_MCP_BROKER_TOKEN is required/u.test(e.message),
    );
    assert.throws(
      () => parseConfig({ ...OAUTH, ...BROKER, HARDCHARGER_MCP_BROKER_URL: "http://broker.test.invalid" }),
      (e: unknown) => e instanceof ConfigError && /must use https/u.test(e.message),
    );
    const insecure = parseConfig({
      ...OAUTH,
      ...BROKER,
      HARDCHARGER_MCP_BROKER_URL: "http://127.0.0.1:9/b/",
      HARDCHARGER_MCP_BROKER_ALLOW_INSECURE: "true",
    });
    assert.equal(insecure.broker?.url, "http://127.0.0.1:9/b");
  });

  it("refuses broker settings without the URL that enables them", () => {
    assert.throws(
      () =>
        parseConfig({
          HARDCHARGER_URI: "hardcharger://db.test.invalid",
          HARDCHARGER_USERNAME: "svc",
          HARDCHARGER_PASSWORD: "pw",
          HARDCHARGER_MCP_BROKER_TOKEN: "x",
        }),
      (e: unknown) => e instanceof ConfigError && /HARDCHARGER_MCP_BROKER_TOKEN is set but HARDCHARGER_MCP_BROKER_URL is not/u.test(e.message),
    );
  });

  it("refuses the stdio transport", async () => {
    await assert.rejects(startStdio(parseConfig({ ...OAUTH, ...BROKER })), (e: unknown) => e instanceof ConfigError && /HTTP transport only/u.test(e.message));
  });
});

describe("BrokerClient", () => {
  const config = parseConfig({ ...OAUTH, ...BROKER }).broker!;

  it("authenticates as this server and presents the caller's token as a subject token, never as the credential", async () => {
    const { seen, fetchImpl } = fakeBroker((s) =>
      s.url.endsWith("/token") ? { body: { token: "minted", expires_in: 600 } } : { body: { connections: [] } },
    );
    const client = new BrokerClient(config, { fetch: fetchImpl });
    await client.listConnections("caller-access-token");
    const minted = await client.issueToken("caller-access-token", "c/1");
    assert.deepEqual(minted, { token: "minted", expiresIn: 600 });
    assert.equal(seen[0].url, "https://broker.test.invalid/mcp-broker/connections");
    assert.equal(seen[1].url, "https://broker.test.invalid/mcp-broker/connections/c%2F1/token");
    for (const s of seen) {
      assert.equal(s.authorization, "Bearer broker-credential-of-this-server");
      assert.deepEqual(s.body, { subject_token: "caller-access-token", subject_token_type: ACCESS_TOKEN_TYPE });
    }
  });

  it("passes the broker's own refusal text through", async () => {
    for (const body of [{ detail: "You no longer have access to analytics." }, { error_description: "You no longer have access to analytics." }]) {
      const { fetchImpl } = fakeBroker(() => ({ status: 403, body }));
      await assert.rejects(
        new BrokerClient(config, { fetch: fetchImpl }).issueToken("t", "c-1"),
        (e: unknown) => e instanceof BrokerError && e.status === 403 && e.message === "You no longer have access to analytics.",
      );
    }
  });

  it("explains a refused credential, an HTTP error without a body, and a malformed answer", async () => {
    const refused = fakeBroker(() => ({ status: 401, raw: "" }));
    await assert.rejects(
      new BrokerClient(config, { fetch: refused.fetchImpl }).listConnections("t"),
      (e: unknown) => e instanceof BrokerError && e.status === 401 && /reconnect the connector/u.test(e.message),
    );
    const broken = fakeBroker(() => ({ status: 502, raw: "<html>bad gateway</html>" }));
    await assert.rejects(
      new BrokerClient(config, { fetch: broken.fetchImpl }).listConnections("t"),
      (e: unknown) => e instanceof BrokerError && e.message === "The connection broker answered HTTP 502.",
    );
    const odd = fakeBroker(() => ({ body: { token: "x" } }));
    await assert.rejects(
      new BrokerClient(config, { fetch: odd.fetchImpl }).issueToken("t", "c-1"),
      (e: unknown) => e instanceof BrokerError && /unexpected body/u.test(e.message),
    );
  });

  it("reports an unreachable broker without its address details", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 10.1.2.3:443");
    }) as typeof fetch;
    await assert.rejects(
      new BrokerClient(config, { fetch: fetchImpl }).listConnections("t"),
      (e: unknown) => e instanceof BrokerError && e.message === "The connection broker is unreachable; try again shortly.",
    );
  });
});

describe("BrokeredRegistry", () => {
  it("lists the caller's connections, skipping ones it can't use", async () => {
    const { r, lines } = registry(() => ({
      body: {
        connections: [
          cluster(),
          cluster({ id: "c-2", name: "Analytics" }), // same name, other case
          cluster({ id: "c-3", name: "bad name!" }),
          cluster({ id: "c-4", name: "nouri", uri: "ftp://x" }),
          { id: "c-5" },
          cluster({ id: "c-6", name: "ops", uri: "hardcharger://ops.test.invalid:8443?tls=false", allow_writes: true, label: null }),
        ],
      },
    }));
    await r.refresh();
    assert.deepEqual(r.names(), ["analytics", "ops"]);
    assert.equal(r.current(), "analytics");
    const [analytics, ops] = r.summaries();
    assert.equal(analytics.id, "c-1");
    assert.equal(analytics.label, "Acme / Analytics / prod");
    assert.equal(analytics.auth, "brokered");
    assert.equal(ops.port, 8443);
    assert.equal(ops.tls, false);
    assert.equal(ops.label, undefined);
    assert.equal(lines.filter((l) => l.includes("skipped")).length, 4, lines.join("\n"));
  });

  it("reuses the list for the cache period, and asks again when forced or stale", async () => {
    const { r, seen, tick } = registry(() => ({ body: { connections: [cluster()] } }), {
      HARDCHARGER_MCP_BROKER_CACHE_SECONDS: "60",
    });
    await r.refresh();
    await r.refresh();
    assert.equal(seen.length, 1);
    await r.refresh({ force: true });
    assert.equal(seen.length, 2);
    tick(61_000);
    await r.refresh();
    assert.equal(seen.length, 3);
  });

  it("keeps an unchanged server's session, closes one the broker stopped listing, and moves current off it", async () => {
    let listed = [cluster(), cluster({ id: "c-2", name: "ops" })];
    const { r } = registry(() => ({ body: { connections: listed } }), { HARDCHARGER_MCP_BROKER_CACHE_SECONDS: "0" });
    await r.refresh();
    const analytics = r.get("analytics");
    r.use("ops");
    const ops = r.get("ops");
    let closed = false;
    ops.close = async () => {
      closed = true;
    };
    listed = [cluster({ allow_writes: true, label: "renamed" })];
    await r.refresh();
    assert.equal(r.get("analytics"), analytics, "same server, same session");
    assert.equal(analytics.config.label, "renamed");
    assert.equal(analytics.config.allowWrites, true);
    assert.ok(closed, "the dropped server's session is closed");
    assert.equal(r.current(), "analytics");
    assert.throws(() => r.get("ops"), /Unknown connection "ops"/u);

    // The same name pointing at another server is a new connection.
    listed = [cluster({ uri: "hardcharger://elsewhere.test.invalid" })];
    await r.refresh();
    assert.notEqual(r.get("analytics"), analytics);
  });

  it("says why there is nothing to use: the broker's message, or the failure", async () => {
    let fail = false;
    const { r } = registry(
      () => (fail ? { status: 503, body: { detail: "maintenance" } } : { body: { connections: [], message: "Create a server first." } }),
      { HARDCHARGER_MCP_BROKER_CACHE_SECONDS: "0" },
    );
    await r.refresh();
    assert.equal(r.current(), null);
    assert.throws(() => r.get(), (e: unknown) => e instanceof NoConnectionsError && e.message === "Create a server first.");
    assert.equal(r.status(), "Create a server first.");
    fail = true;
    await r.refresh();
    assert.throws(() => r.get(), (e: unknown) => e instanceof NoConnectionsError && e.message === "maintenance");
  });

  it("keeps the last list through a broker failure only while it is fresh, then closes its connections", async () => {
    let answer: "ok" | "500" | "garbled" = "ok";
    const { r, lines, tick } = registry(
      () => (answer === "500" ? { status: 500, raw: "" } : answer === "garbled" ? { body: { connections: null } } : { body: { connections: [cluster()] } }),
      { HARDCHARGER_MCP_BROKER_CACHE_SECONDS: "60" },
    );
    await r.refresh();
    const conn = r.get("analytics");
    answer = "500";
    await r.refresh({ force: true }); // list_connections, 10 s later
    assert.deepEqual(r.names(), ["analytics"], "the list is 0 s old: still current");
    assert.equal(r.get("analytics"), conn);
    assert.equal(r.status(), "The connection broker answered HTTP 500.");
    assert.ok(lines.some((l) => l.includes("connection broker: The connection broker answered HTTP 500.")), lines.join("\n"));

    answer = "garbled";
    tick(60_000); // the list is as old as the cache period: it can't be renewed, so it ends
    await r.refresh();
    assert.deepEqual(r.names(), []);
    assert.throws(() => r.get(), (e: unknown) => e instanceof NoConnectionsError && /unexpected body/u.test(e.message));
    await assert.rejects(conn.query("SELECT 1"), (e: unknown) => e instanceof ConnectionReplacedError);

    answer = "ok"; // the broker answers again
    await r.refresh();
    assert.deepEqual(r.names(), ["analytics"]);
    assert.equal(r.status(), undefined);
  });

  it("treats a refused list (4xx) as nothing listed, at once, and says why", async () => {
    let refuse = false;
    const { r } = registry(
      () => (refuse ? { status: 403, body: { detail: "Your organization is suspended." } } : { body: { connections: [cluster()] } }),
      { HARDCHARGER_MCP_BROKER_CACHE_SECONDS: "60" },
    );
    await r.refresh();
    refuse = true;
    await r.refresh({ force: true });
    assert.deepEqual(r.names(), []);
    assert.throws(() => r.get(), (e: unknown) => e instanceof NoConnectionsError && e.message === "Your organization is suspended.");
    for (const transient of [408, 429]) {
      const t = registry(() => (refuse ? { status: transient, body: {} } : { body: { connections: [cluster()] } }), {
        HARDCHARGER_MCP_BROKER_CACHE_SECONDS: "60",
      });
      refuse = false;
      await t.r.refresh();
      refuse = true;
      await t.r.refresh({ force: true });
      assert.deepEqual(t.r.names(), ["analytics"], `${transient} is an outage, not a refusal`);
    }
  });

  it("mints a token per server with the newest caller token, reuses it for most of its life, then mints again", async () => {
    let n = 0;
    const { r, seen, tick } = registry((s) =>
      s.url.endsWith("/token") ? { body: { token: `minted-${++n}`, expires_in: 100 } } : { body: { connections: [cluster()] } },
    );
    await r.refresh();
    const source = r.get("analytics").config.tokenSource!;
    const [a, b] = await Promise.all([source.token(), source.token()]);
    assert.equal(a, "minted-1");
    assert.equal(b, "minted-1", "concurrent sign-ins share one request");
    tick(79_000);
    assert.equal(await source.token(), "minted-1");
    r.setSubjectToken("newer-caller-token");
    tick(2_000); // past 80% of 100 s
    assert.equal(await source.token(), "minted-2");
    const mints = seen.filter((s) => s.url.endsWith("/token"));
    assert.equal(mints.length, 2);
    assert.equal(mints[1].body.subject_token, "newer-caller-token");
  });

  it("signs in by token exchange with a fresh broker token, never with a stored credential", async () => {
    const { r } = registry((s) =>
      s.url.endsWith("/token") ? { body: { token: "minted", expires_in: 100 } } : { body: { connections: [cluster()] } },
    );
    await r.refresh();
    const options = r.get("analytics").clientOptions();
    assert.equal(options.username, undefined);
    assert.equal(options.password, undefined);
    assert.equal(options.token, undefined);
    assert.equal(typeof options.subjectToken, "function");
    assert.equal(await (options.subjectToken as () => Promise<string>)(), "minted");
  });

  it("redacts the caller's token, minted tokens and the broker credential", async () => {
    const { r } = registry((s) =>
      s.url.endsWith("/token") ? { body: { token: "minted-secret", expires_in: 100 } } : { body: { connections: [cluster()] } },
    );
    await r.refresh();
    await r.get("analytics").config.tokenSource!.token();
    assert.equal(
      r.redact("a caller-access-token b minted-secret c broker-credential-of-this-server"),
      "a *** b *** c ***",
    );
  });

  it("accepts writes only where the broker allows them and HARDCHARGER_ALLOW_WRITES is on", async () => {
    const answer = () => ({ body: { connections: [cluster({ allow_writes: true }), cluster({ id: "c-2", name: "ops" })] } });
    const off = registry(answer);
    await off.r.refresh();
    assert.equal(off.r.allowsWrites(off.r.get("analytics")), false, "the server-wide ceiling is off");
    assert.equal(off.r.anyAllowsWrites(), false);

    const on = registry(answer, { HARDCHARGER_ALLOW_WRITES: "true" });
    await on.r.refresh();
    assert.equal(on.r.allowsWrites(on.r.get("analytics")), true);
    assert.equal(on.r.allowsWrites(on.r.get("ops")), false, "the broker said no");
    assert.deepEqual(
      on.r.summaries().map((s) => s.allow_writes),
      [true, false],
    );
  });

  it("lists table resources only for servers the caller already uses", async () => {
    const { r } = registry(() => ({ body: { connections: [cluster(), cluster({ id: "c-2", name: "ops" })] } }));
    await r.refresh();
    assert.deepEqual(r.resourceConnections(), []);
  });
});

interface ScriptedSession {
  no: number;
  /** The server made this session read-only (it was asked to, and is new enough). */
  readOnly: boolean;
  /** Options set after creation (catalog, schema). */
  options: Record<string, unknown>;
  statements: string[];
  closed: boolean;
}

/**
 * A scripted Hardcharger client for brokered connections: one session per connect, recording its
 * options and statements; `read_only` is confirmed only when the server is new enough
 * (`readOnlySessions`). A "HOLD" statement waits until its client is closed (then fails as a closed
 * connection does); `gate` holds the next connect, or the first request of a lazily connected client
 * (the sign-in that wakes a stopped cluster), until `release()`.
 */
function scriptedServer(script: { readOnlySessions?: boolean } = {}) {
  const sessions: ScriptedSession[] = [];
  let held: { started: () => void } | undefined;
  let gate: { at: "connect" | "first-request"; reached: () => void; released: Promise<void> } | undefined;
  let release = () => {};
  const passGate = async (at: "connect" | "first-request") => {
    if (gate?.at !== at) return;
    const g = gate;
    gate = undefined;
    g.reached();
    await g.released;
  };
  const connect = async (options: { url: string; sessionOptions?: Record<string, unknown> }) => {
    const session: ScriptedSession = {
      no: sessions.length + 1,
      readOnly: options.sessionOptions?.read_only === true && script.readOnlySessions !== false,
      options: { ...options.sessionOptions },
      statements: [],
      closed: false,
    };
    sessions.push(session);
    let onClose: (() => void) | undefined;
    await passGate("connect");
    let first = true;
    const run = async (sql: string) => {
      if (first) {
        first = false;
        await passGate("first-request");
      }
      if (/hardcharger_settings\(\)/u.test(sql)) return tableFromArrays({ name: [] as string[], value: [] as string[] });
      session.statements.push(sql);
      if (sql === "HOLD") {
        const h = held;
        held = undefined;
        await new Promise<void>((_resolve, reject) => {
          onClose = () => reject(new HardchargerError({ code: "client_connection_closed", message: "closed" } as never));
          h?.started();
        });
      }
      return tableFromArrays({ x: Int32Array.from([1]) });
    };
    return {
      sessionReplacements: 0,
      sessionId: `s${session.no}`,
      server: { protocol: "chargewire", protocol_versions: ["1"], capabilities: [] },
      async setOptions(o: Record<string, unknown>) {
        Object.assign(session.options, o);
        return { ...session.options };
      },
      async getSession() {
        // A server before Hardcharger 2.13.0 ignores the option it doesn't know.
        const { read_only: _ignored, ...rest } = session.options;
        return { session_id: `s${session.no}`, options: session.readOnly ? { ...rest, read_only: true } : rest, idle_timeout_s: 600 };
      },
      query: (sql: string) => run(sql),
      async execute(sql: string) {
        await run(sql);
        return 0;
      },
      async close() {
        session.closed = true;
        onClose?.();
      },
    };
  };
  return {
    connect,
    sessions,
    /** What each connect asked for at session creation. */
    get connects() {
      return sessions.map((s) => ({ sessionOptions: s.options.read_only === true ? { read_only: true } : undefined }));
    },
    /** Every statement, over all sessions, in order of session. */
    get statements() {
      return sessions.flatMap((s) => s.statements);
    },
    /** The numbers of the sessions closed. */
    get closed() {
      return sessions.filter((s) => s.closed).map((s) => s.no);
    },
    /** The next "HOLD" statement waits until its client closes; resolves once it is running. */
    holdNext: () => new Promise<void>((started) => (held = { started })),
    /** Holds the next connect (or its first request) until release(); resolves once it is held. */
    gateNext: (at: "connect" | "first-request") =>
      new Promise<void>((reached) => {
        let open!: () => void;
        gate = { at, reached, released: new Promise<void>((r) => (open = r)) };
        release = open;
      }),
    release: () => release(),
  };
}

function brokeredWith(
  server: ReturnType<typeof scriptedServer>,
  listed: () => unknown[],
  env: Record<string, string> = {},
): { r: BrokeredRegistry; lines: string[] } {
  const config = parseConfig({ ...OAUTH, ...BROKER, HARDCHARGER_MCP_BROKER_CACHE_SECONDS: "0", ...env });
  const { fetchImpl } = fakeBroker((s) =>
    s.url.endsWith("/token") ? { body: { token: "minted", expires_in: 600 } } : { body: { connections: listed() } },
  );
  const lines: string[] = [];
  const r = new BrokeredRegistry(config, new BrokerClient(config.broker!, { fetch: fetchImpl }), (m) => lines.push(m), {
    connect: server.connect as never,
  });
  r.setSubjectToken("caller-access-token");
  return { r, lines };
}

describe("BrokeredRegistry: read_only per connection", () => {
  const four = () => [
    cluster({ name: "required", read_only: true, allow_writes: true }),
    cluster({ id: "c-2", name: "lifted", read_only: false, allow_writes: true }),
    cluster({ id: "c-3", name: "absent", allow_writes: true }),
    cluster({ id: "c-4", name: "nulled", read_only: null, allow_writes: true }),
  ];

  it("lets the broker require read-only per connection; absent or null keeps the server's default", async () => {
    const { r } = registry(() => ({ body: { connections: four() } }), { HARDCHARGER_ALLOW_WRITES: "true" });
    await r.refresh();
    assert.deepEqual(
      r.summaries().map((s) => [s.name, s.read_only_required, s.allow_writes]),
      [
        ["required", true, false],
        ["lifted", false, true],
        ["absent", false, true],
        ["nulled", false, true],
      ],
    );
  });

  it("never lets the broker lift HARDCHARGER_READ_ONLY=true (a floor), and offers no writes then", async () => {
    const { r } = registry(() => ({ body: { connections: four() } }), {
      HARDCHARGER_ALLOW_WRITES: "true",
      HARDCHARGER_READ_ONLY: "true",
    });
    await r.refresh();
    assert.deepEqual(
      r.summaries().map((s) => [s.name, s.read_only_required, s.allow_writes]),
      [
        ["required", true, false],
        ["lifted", true, false],
        ["absent", true, false],
        ["nulled", true, false],
      ],
    );
    assert.equal(r.anyAllowsWrites(), false);
  });

  it("skips an entry whose read_only is not a boolean, rather than guess", async () => {
    const { r, lines } = registry(() => ({
      body: { connections: [cluster({ read_only: "true" }), cluster({ id: "c-2", name: "ops" })] },
    }));
    await r.refresh();
    assert.deepEqual(r.names(), ["ops"]);
    assert.ok(lines.some((l) => l.includes("skipped a connection with an unexpected shape")), lines.join("\n"));
  });

  it("requests read-only at session creation and confirms it before any query, on the required connection only", async () => {
    const server = scriptedServer();
    const { r } = brokeredWith(server, () => [cluster({ read_only: true }), cluster({ id: "c-2", name: "ops" })]);
    await r.refresh();
    await r.get("analytics").query("SELECT 1");
    await r.get("ops").query("SELECT 2");
    assert.deepEqual(
      server.connects.map((c) => c.sessionOptions),
      [{ read_only: true }, undefined],
    );
    assert.deepEqual(server.statements, ["SELECT 1", "SELECT 2"]);
  });

  it("refuses to run anything on a server that doesn't confirm read-only (before Hardcharger 2.13.0)", async () => {
    const server = scriptedServer({ readOnlySessions: false });
    const { r } = brokeredWith(server, () => [cluster({ read_only: true }), cluster({ id: "c-2", name: "ops" })]);
    await r.refresh();
    await assert.rejects(r.get("analytics").query("SELECT 1"), /did not confirm read_only=true/u);
    assert.deepEqual(server.statements, [], "nothing ran on the unconfirmed session");
    assert.deepEqual(server.closed, [1], "the unconfirmed session is closed");
    // The same old server, where the broker didn't ask for read-only: works as before.
    await r.get("ops").query("SELECT 2");
    assert.deepEqual(server.statements, ["SELECT 2"]);
  });

  it("replaces the connection when read_only changes: the old session closes and never opens again", async () => {
    const server = scriptedServer();
    let readOnly: boolean | undefined;
    const { r, lines } = brokeredWith(server, () => [cluster({ read_only: readOnly, allow_writes: true })], {
      HARDCHARGER_ALLOW_WRITES: "true",
    });
    await r.refresh();
    const writable = r.get("analytics");
    await writable.update("INSERT INTO t VALUES (1)");
    assert.equal(r.allowsWrites(writable), true);

    readOnly = true; // an administrator turned AI writes off
    await r.refresh();
    const readOnlyConn = r.get("analytics");
    assert.notEqual(readOnlyConn, writable, "a new connection, not the read-write session");
    assert.deepEqual(server.closed, [1], "the read-write session is closed");
    assert.equal(r.allowsWrites(readOnlyConn), false);
    assert.equal(r.current(), "analytics");
    // A caller still holding the old connection can't open a read-write session again.
    await assert.rejects(writable.update("INSERT INTO t VALUES (2)"), (e: unknown) => {
      assert.ok(e instanceof ConnectionReplacedError, String(e));
      assert.match((e as Error).message, /now requires a read-only session/u);
      return true;
    });
    assert.equal(server.connects.length, 1, "no session opened for the retired connection");
    await readOnlyConn.query("SELECT 1");
    assert.deepEqual(server.connects.at(-1)?.sessionOptions, { read_only: true });
    assert.ok(lines.some((l) => /closing connection analytics: replaced: the connection now requires a read-only session/u.test(l)), lines.join("\n"));

    readOnly = false; // and on again: a read-only session can't become read-write, so a new one
    await r.refresh();
    const again = r.get("analytics");
    assert.notEqual(again, readOnlyConn);
    assert.deepEqual(server.closed, [1, 2]);
    await again.update("INSERT INTO t VALUES (3)");
    assert.equal(server.connects.at(-1)?.sessionOptions, undefined);
    assert.deepEqual(server.statements, ["INSERT INTO t VALUES (1)", "SELECT 1", "INSERT INTO t VALUES (3)"]);
  });

  it("keeps the session when only allow_writes or the label changes", async () => {
    const server = scriptedServer();
    let allow = true;
    const { r } = brokeredWith(server, () => [cluster({ read_only: true, allow_writes: allow, label: `l-${allow}` })]);
    await r.refresh();
    const conn = r.get("analytics");
    await conn.query("SELECT 1");
    allow = false;
    await r.refresh();
    assert.equal(r.get("analytics"), conn);
    assert.deepEqual(server.closed, []);
  });

  it("fails, without running it, the first statement after a replacement when a transaction may have been open", async () => {
    const server = scriptedServer();
    let readOnly = false;
    const { r, lines } = brokeredWith(server, () => [cluster({ read_only: readOnly, allow_writes: true })], {
      HARDCHARGER_ALLOW_WRITES: "true",
    });
    await r.refresh();
    await r.get().update("BEGIN");
    await r.get().update("INSERT INTO t VALUES (1)");
    readOnly = true;
    await r.refresh();
    await assert.rejects(r.get().query("COMMIT"), (e: unknown) => {
      assert.ok(e instanceof TransactionLostError, String(e));
      assert.match((e as Error).message, /new Hardcharger session \(replaced: the connection now requires a read-only session\)/u);
      assert.match((e as Error).message, /If a transaction was still open there, the server rolled it back/u);
      assert.match((e as Error).message, /This statement was not run\./u);
      return true;
    });
    assert.deepEqual(server.statements, ["BEGIN", "INSERT INTO t VALUES (1)"], "COMMIT never ran on the new session");
    assert.ok(lines.some((l) => /a transaction possibly open; statement not run/u.test(l)), lines.join("\n"));
    // Once: the connection is usable after that.
    await r.get().query("SELECT 1");
    assert.deepEqual(server.statements.at(-1), "SELECT 1");
  });

  it("fails the first statement after a replacement when SQL set session settings, and not otherwise", async () => {
    const server = scriptedServer();
    let readOnly = false;
    const { r } = brokeredWith(server, () => [cluster({ read_only: readOnly })]);
    await r.refresh();
    await r.get().query("SET threads = 2");
    readOnly = true;
    await r.refresh();
    await assert.rejects(r.get().query("SELECT 1"), (e: unknown) => e instanceof SettingsLostError);
    assert.deepEqual(server.statements, ["SET threads = 2"]);

    // Plain reads on the old session: the next statement simply runs on the new one.
    await r.get().query("SELECT 2");
    readOnly = false;
    await r.refresh();
    await r.get().query("SELECT 3");
    assert.deepEqual(server.statements, ["SET threads = 2", "SELECT 2", "SELECT 3"]);
  });

  it("a statement in flight when read_only changes is not retried on a session with the old settings", { timeout: 5000 }, async () => {
    const server = scriptedServer();
    let readOnly = false;
    const { r } = brokeredWith(server, () => [cluster({ read_only: readOnly, allow_writes: true })], {
      HARDCHARGER_ALLOW_WRITES: "true",
    });
    await r.refresh();
    const old = r.get();
    const running = server.holdNext();
    const call = old.update("HOLD");
    await running;
    readOnly = true;
    await r.refresh();
    await assert.rejects(call, (e: unknown) => e instanceof ConnectionReplacedError);
    assert.equal(server.connects.length, 1, "the lost statement was not retried on a new read-write session");
  });
});

describe("BrokeredRegistry: what a replaced connection leaves behind", () => {
  const WRITES = { HARDCHARGER_ALLOW_WRITES: "true" };

  for (const at of ["connect", "first-request"] as const) {
    it(`a call still connecting when read_only is turned on never runs on the read-write session (held at ${at})`, { timeout: 5000 }, async () => {
      const server = scriptedServer();
      let readOnly = false;
      const { r } = brokeredWith(server, () => [cluster({ read_only: readOnly, allow_writes: true })], WRITES);
      await r.refresh();
      const old = r.get();
      const held = server.gateNext(at); // a stopped cluster resuming, or a slow first sign-in
      const call = old.update("DELETE FROM orders");
      call.catch(() => undefined);
      await held;
      readOnly = true;
      await r.refresh();
      server.release();
      await assert.rejects(call, (e: unknown) => {
        assert.ok(e instanceof ConnectionReplacedError, String(e));
        assert.match((e as Error).message, /now requires a read-only session/u);
        return true;
      });
      assert.deepEqual(server.statements, [], "nothing ran on the read-write session");
      assert.deepEqual(
        server.sessions.map((s) => [s.readOnly, s.closed]),
        [[false, true]],
        "the read-write session opened late is closed, not left open on the server",
      );
      await r.get().query("SELECT 1");
      assert.deepEqual(server.sessions[1]?.readOnly, true);
    });
  }

  it("a call still connecting when the person's MCP session is closed (idle, pool full) leaves no session open", { timeout: 5000 }, async () => {
    const server = scriptedServer();
    const { r } = brokeredWith(server, () => [cluster({ allow_writes: true })], WRITES);
    await r.refresh();
    const held = server.gateNext("connect");
    const call = r.get().update("DELETE FROM orders");
    call.catch(() => undefined);
    await held;
    await r.close();
    server.release();
    await assert.rejects(call, (e: unknown) => e instanceof ConnectionReplacedError && /the MCP session was closed/u.test((e as Error).message));
    assert.deepEqual(server.statements, []);
    assert.deepEqual(server.closed, [1]);
  });

  it("keeps the catalog and schema the person chose across a read_only change on the same server", async () => {
    const server = scriptedServer();
    let readOnly = true;
    const { r } = brokeredWith(
      server,
      () => [cluster({ read_only: readOnly, allow_writes: true, default_catalog: "lake", default_schema: "main" })],
      WRITES,
    );
    await r.refresh();
    await r.get().useSchema({ catalog: "lake", schema: "staging" });
    readOnly = false; // AI writes turned on: a new session
    await r.refresh();
    assert.deepEqual(r.get().currentSearchPath(), { catalog: "lake", schema: "staging" });
    await r.get().update("DELETE FROM orders");
    assert.deepEqual(server.sessions[1]?.options, { catalog: "lake", schema: "staging" });
    assert.deepEqual(server.sessions[1]?.statements, ["DELETE FROM orders"]);
    assert.deepEqual(r.summaries()[0]?.default_schema, "staging");
  });

  it("takes the broker's new default when the person never chose a schema, and never carries one to another server", async () => {
    const server = scriptedServer();
    let entry = cluster({ default_catalog: "lake", default_schema: "main" });
    const { r } = brokeredWith(server, () => [entry]);
    await r.refresh();
    await r.get().query("SELECT 1");
    entry = cluster({ read_only: true, default_catalog: "lake", default_schema: "reporting" });
    await r.refresh();
    assert.deepEqual(r.get().currentSearchPath(), { catalog: "lake", schema: "reporting" });

    await r.get().useSchema({ catalog: "lake", schema: "staging" });
    entry = cluster({ read_only: true, uri: "hardcharger://elsewhere.test.invalid", default_catalog: "lake", default_schema: "main" });
    await r.refresh();
    assert.deepEqual(r.get().currentSearchPath(), { catalog: "lake", schema: "main" });
  });

  it("reports a possibly open transaction after two replacements with no statement in between", async () => {
    const server = scriptedServer();
    let readOnly = false;
    const { r } = brokeredWith(server, () => [cluster({ read_only: readOnly, allow_writes: true })], WRITES);
    await r.refresh();
    await r.get().update("BEGIN");
    await r.get().update("INSERT INTO t VALUES (1)");
    readOnly = true;
    await r.refresh(); // list_connections: no statement
    readOnly = false;
    await r.refresh();
    await assert.rejects(r.get().update("INSERT INTO t VALUES (2)"), (e: unknown) => e instanceof TransactionLostError);
    assert.deepEqual(server.statements, ["BEGIN", "INSERT INTO t VALUES (1)"]);
  });

  it("reports a possibly open transaction, and keeps the chosen schema, when a connection comes back after one list without it", async () => {
    const server = scriptedServer();
    let listed = true;
    const { r } = brokeredWith(server, () => (listed ? [cluster({ allow_writes: true })] : [cluster({ id: "c-2", name: "ops" })]), WRITES);
    await r.refresh();
    await r.get("analytics").useSchema({ catalog: "lake", schema: "staging" });
    await r.get("analytics").update("BEGIN");
    await r.get("analytics").update("INSERT INTO t VALUES (1)");
    listed = false;
    await r.refresh();
    listed = true;
    await r.refresh();
    await assert.rejects(r.get("analytics").update("INSERT INTO t VALUES (2)"), (e: unknown) => {
      assert.ok(e instanceof TransactionLostError, String(e));
      assert.match((e as Error).message, /missing from an earlier list/u);
      return true;
    });
    assert.deepEqual(r.get("analytics").currentSearchPath(), { catalog: "lake", schema: "staging" });
    await r.get("analytics").update("INSERT INTO t VALUES (2)");
    assert.deepEqual(server.statements, ["BEGIN", "INSERT INTO t VALUES (1)", "INSERT INTO t VALUES (2)"]);
  });

  it("does not report a transaction that a COMMIT or ROLLBACK ended", async () => {
    for (const end of ["COMMIT", "rollback;", "END TRANSACTION", "/* done */ COMMIT WORK"]) {
      const server = scriptedServer();
      let readOnly = false;
      const { r } = brokeredWith(server, () => [cluster({ read_only: readOnly, allow_writes: true })], WRITES);
      await r.refresh();
      await r.get().update("BEGIN");
      await r.get().update("INSERT INTO t VALUES (1)");
      await r.get().update(end);
      readOnly = true;
      await r.refresh();
      await r.get().query("SELECT count(*) FROM t");
      assert.deepEqual(server.statements.at(-1), "SELECT count(*) FROM t", end);
    }
  });

  it("still reports a transaction after ROLLBACK TO SAVEPOINT, COMMIT with more SQL, or with autocommit switched", async () => {
    for (const steps of [
      ["BEGIN", "ROLLBACK TO SAVEPOINT s1"],
      ["BEGIN", "COMMIT; BEGIN"],
      ["SET autocommit = false", "COMMIT"],
    ]) {
      const server = scriptedServer();
      let readOnly = false;
      const { r } = brokeredWith(server, () => [cluster({ read_only: readOnly, allow_writes: true })], WRITES);
      await r.refresh();
      for (const sql of steps) await r.get().update(sql);
      readOnly = true;
      await r.refresh();
      await assert.rejects(r.get().query("SELECT 1"), (e: unknown) => e instanceof TransactionLostError, steps.join(" / "));
    }
  });

  it("keeps a retired connection's sign-in tokens redacted until they expire", async () => {
    let listed = true;
    let now = 1_000_000;
    const config = parseConfig({ ...OAUTH, ...BROKER, HARDCHARGER_MCP_BROKER_CACHE_SECONDS: "0" });
    const { fetchImpl } = fakeBroker((s) =>
      s.url.endsWith("/token") ? { body: { token: "minted-secret", expires_in: 100 } } : { body: { connections: listed ? [cluster()] : [] } },
    );
    const r = new BrokeredRegistry(config, new BrokerClient(config.broker!, { fetch: fetchImpl }), () => undefined, { now: () => now });
    r.setSubjectToken("caller-access-token");
    await r.refresh();
    await r.get().config.tokenSource!.token();
    listed = false;
    await r.refresh();
    assert.equal(r.redact("x minted-secret y"), "x *** y");
    now += 101_000;
    assert.equal(r.redact("x minted-secret y"), "x minted-secret y", "expired: no longer kept");
  });
});

describe("endsTransaction", () => {
  it("is one COMMIT, END, ABORT or ROLLBACK statement, and nothing else", () => {
    for (const sql of ["COMMIT", "commit;", " END ", "ABORT", "ROLLBACK WORK", "rollback transaction ;", "-- x\nCOMMIT"]) {
      assert.equal(endsTransaction(sql), true, sql);
    }
    for (const sql of ["ROLLBACK TO SAVEPOINT a", "COMMIT; BEGIN", "BEGIN; COMMIT", "SELECT 'COMMIT'", "COMMITTED", "UPDATE t SET end = 1"]) {
      assert.equal(endsTransaction(sql), false, sql);
    }
  });
});

describe("token checks by the broker (opaque access tokens)", () => {
  const oauth = parseConfig({ ...OAUTH, ...BROKER }).mcpOAuth!;

  function verifier(answer: (token: string) => { active: boolean; sub?: string; email?: string }, emails: string[] = []) {
    const calls: string[] = [];
    let now = 1_000_000;
    const v = new OAuthVerifier(
      { ...oauth, authorizedEmails: emails },
      { introspect: async (t) => (calls.push(t), answer(t)), now: () => now },
    );
    return { v, calls, tick: (ms: number) => (now += ms) };
  }

  it("asks the broker, and reuses an active answer briefly", async () => {
    const { v, calls, tick } = verifier(() => ({ active: true, sub: "user_1", email: "ann@example.com" }));
    const user = await v.verify("Bearer oat_abc");
    assert.equal(user.subject, "user_1");
    assert.equal(user.email, "ann@example.com");
    await v.verify("Bearer oat_abc");
    assert.equal(calls.length, 1);
    tick(INTROSPECTION_CACHE_MS + 1);
    await v.verify("Bearer oat_abc");
    assert.equal(calls.length, 2);
  });

  it("refuses an inactive token, and asks again next time", async () => {
    const { v, calls } = verifier(() => ({ active: false }));
    for (let i = 0; i < 2; i++) {
      await assert.rejects(v.verify("Bearer oat_dead"), (e: unknown) => e instanceof OAuthError && e.status === 401);
    }
    assert.equal(calls.length, 2);
  });

  it("still applies the email allowlist", async () => {
    const { v } = verifier(() => ({ active: true, sub: "u", email: "eve@elsewhere.org" }), ["*@example.com"]);
    await assert.rejects(v.verify("Bearer oat_x"), (e: unknown) => e instanceof OAuthError && e.status === 403);
  });

  it("BrokerClient.introspect posts the token as a subject token and reads the answer", async () => {
    const { seen, fetchImpl } = fakeBroker(() => ({ body: { active: true, sub: "user_1", email: "ann@example.com", name: null } }));
    const r = await new BrokerClient(parseConfig({ ...OAUTH, ...BROKER }).broker!, { fetch: fetchImpl }).introspect("oat_abc");
    assert.deepEqual(r, { active: true, sub: "user_1", email: "ann@example.com", name: undefined });
    assert.equal(seen[0].url, "https://broker.test.invalid/mcp-broker/introspect");
    assert.equal(seen[0].authorization, "Bearer broker-credential-of-this-server");
    assert.equal(seen[0].body.subject_token, "oat_abc");
  });
});
