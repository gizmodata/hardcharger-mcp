import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ACCESS_TOKEN_TYPE, BrokerClient, BrokerError, BrokeredRegistry } from "../../dist/broker.js";
import { ConfigError, parseConfig } from "../../dist/connection.js";
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

  it("keeps the last list when the broker fails", async () => {
    let fail = false;
    const { r, lines } = registry(() => (fail ? { status: 500, raw: "" } : { body: { connections: [cluster()] } }), {
      HARDCHARGER_MCP_BROKER_CACHE_SECONDS: "0",
    });
    await r.refresh();
    fail = true;
    await r.refresh();
    assert.deepEqual(r.names(), ["analytics"]);
    assert.equal(r.status(), "The connection broker answered HTTP 500.");
    assert.ok(lines.some((l) => l.includes("connection broker: The connection broker answered HTTP 500.")), lines.join("\n"));
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
