// login_sso on Warp SQL browser sign-in (§4.3): the flow calls are scripted, so these tests pin
// how runSsoLogin reads each answer (pending, complete, a failed flow's code, a flow the server
// no longer knows, a server without browser sign-in) without a server. test/live/auth.test.ts
// runs the real flow against hardcharger-server and an identity provider.

import assert from "node:assert/strict";
import * as net from "node:net";
import { before, describe, it } from "node:test";

import { HardchargerError, HardchargerErrorCode, type BrowserSignInFlow, type BrowserSignInPoll } from "@gizmodata/hardcharger";

import { HardchargerConnection, parseConfig } from "../../dist/connection.js";
import { runSsoLogin, type BrowserSignInCalls, type SsoOptions } from "../../dist/sso.js";

/** A TCP port nothing listens on, so a reconnect attempt fails fast. */
async function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function connection(port: number): HardchargerConnection {
  const cfg = parseConfig({
    HARDCHARGER_URI: `hardcharger://127.0.0.1:${port}?tls=false`,
    HARDCHARGER_ENABLE_SSO: "true",
  });
  return new HardchargerConnection(cfg.connections[0], () => {});
}

const flow1: BrowserSignInFlow = {
  flowId: "f_1",
  pollSecret: "poll-secret-1",
  authorizeUrl: "https://idp.test/authorize?state=abc",
  pollIntervalS: 2,
  expiresAt: "2099-01-01T00:00:00Z",
};

const hcError = (code: string, message = code) =>
  new HardchargerError({ code, message } as ConstructorParameters<typeof HardchargerError>[0]);

type Answer = BrowserSignInPoll | Error;

/** Scripted flow calls: what start answers (a flow or an error) and a queue of poll answers. */
function scripted(start: BrowserSignInFlow | Error, polls: Answer[]) {
  const started: string[] = [];
  const polled: Array<{ url: string; flowId: string; pollSecret: string }> = [];
  const opened: string[] = [];
  const calls: BrowserSignInCalls = {
    async start(target) {
      started.push(target.url);
      if (start instanceof Error) throw start;
      return start;
    },
    async poll(target, flow) {
      polled.push({ url: target.url, flowId: flow.flowId, pollSecret: flow.pollSecret });
      const next = polls.shift();
      if (next === undefined) throw new Error("no scripted poll answer left");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const options: SsoOptions = {
    waitSeconds: 1,
    pollIntervalMs: 1,
    calls,
    openUrl: async (url) => {
      opened.push(url);
    },
  };
  return { options, started, polled, opened };
}

const pending: BrowserSignInPoll = { state: "pending" };

describe("runSsoLogin", () => {
  let port = 0;
  before(async () => {
    port = await closedPort();
  });

  it("reports unavailable when the server doesn't offer browser sign-in (not_implemented)", async () => {
    const { options } = scripted(hcError("not_implemented", "browser sign-in is not configured on this server"), []);
    const r = await runSsoLogin(connection(port), options);
    assert.equal(r.status, "unavailable");
    assert.match(r.message, new RegExp(`at hardcharger://127\\.0\\.0\\.1:${port}\\?tls=false offers no browser sign-in`));
    assert.match(r.message, /not_implemented: browser sign-in is not configured/);
    assert.match(r.message, /--oauth-client-id/);
  });

  it("reports unavailable when nothing answers (client_transport_error), with the real client", async () => {
    const r = await runSsoLogin(connection(port), { waitSeconds: 1, openUrl: async () => {} });
    assert.equal(r.status, "unavailable");
    assert.match(r.message, /offers no browser sign-in/);
  });

  it("starts the flow on the connection's own URI, opens the browser, and returns pending with the URL", async () => {
    const { options, opened, started, polled } = scripted(flow1, Array(500).fill(pending));
    const r = await runSsoLogin(connection(port), { ...options, waitSeconds: 0.05 });
    assert.equal(r.status, "pending");
    assert.equal(r.authUrl, flow1.authorizeUrl);
    assert.match(r.message, /open this URL: https:\/\/idp\.test\/authorize/);
    assert.deepEqual(opened, [flow1.authorizeUrl]);
    assert.deepEqual(started, [`hardcharger://127.0.0.1:${port}?tls=false`], "the Warp SQL port, no separate sign-in port");
    assert.ok(polled.length > 0);
    assert.ok(polled.every((p) => p.flowId === "f_1" && p.pollSecret === "poll-secret-1"));
  });

  it("waits the server's poll interval when no override is given", async () => {
    const { options, polled } = scripted({ ...flow1, pollIntervalS: 0.2 }, Array(50).fill(pending));
    delete options.pollIntervalMs;
    await runSsoLogin(connection(port), { ...options, waitSeconds: 0.5 });
    assert.ok(polled.length >= 2 && polled.length <= 4, `polled ${polled.length} times in 0.5 s at 0.2 s`);
  });

  it("resumes a pending flow on the next call instead of starting a new one", async () => {
    const conn = connection(port);
    const first = scripted(flow1, Array(500).fill(pending));
    await runSsoLogin(conn, { ...first.options, waitSeconds: 0.02 });
    const second = scripted({ ...flow1, flowId: "would-be-new" }, [hcError("access_denied", "browser sign-in failed: no (access_denied)")]);
    const r = await runSsoLogin(conn, second.options);
    assert.deepEqual(second.started, [], "no new sign-in started");
    assert.deepEqual(second.opened, [], "browser not re-opened");
    assert.ok(second.polled.every((p) => p.flowId === "f_1"), "polls the original flow");
    assert.equal(r.status, "error");
    assert.equal(r.message, "Browser sign-in failed: no (access_denied)");
  });

  it("starts a new flow once the pending one is past its expiry", async () => {
    const conn = connection(port);
    const first = scripted({ ...flow1, expiresAt: new Date(Date.now() + 30).toISOString() }, Array(500).fill(pending));
    await runSsoLogin(conn, { ...first.options, waitSeconds: 0.01 });
    await new Promise((r) => setTimeout(r, 40));
    const second = scripted({ ...flow1, flowId: "f_2" }, [hcError("access_denied")]);
    await runSsoLogin(conn, second.options);
    assert.equal(second.started.length, 1);
    assert.ok(second.polled.every((p) => p.flowId === "f_2"));
  });

  it("maps flow_not_found (expired or collected) to an error and forgets the flow", async () => {
    const conn = connection(port);
    const nf = scripted(flow1, [hcError("flow_not_found")]);
    const r1 = await runSsoLogin(conn, nf.options);
    assert.equal(r1.status, "error");
    assert.match(r1.message, /expired or was already used/);
    const again = scripted({ ...flow1, flowId: "f_2" }, [hcError("identity_provider_error", "the provider failed (identity_provider_error)")]);
    const r2 = await runSsoLogin(conn, again.options);
    assert.equal(again.started.length, 1, "a fresh sign-in is started after the previous one was forgotten");
    assert.equal(r2.status, "error");
    assert.match(r2.message, /identity_provider_error/);
  });

  it("names a failed flow's code even when its message doesn't (no HTTP status on a failed flow)", async () => {
    const { options } = scripted(flow1, [hcError(HardchargerErrorCode.invalidCredentials, "User 'x' is not authorized")]);
    const r = await runSsoLogin(connection(port), options);
    assert.equal(r.status, "error");
    assert.equal(r.message, "Browser sign-in failed: User 'x' is not authorized (invalid_credentials)");
  });

  it("switches to the server's access token on completion and reports a connect failure without leaking it", async () => {
    const conn = connection(port);
    const { options } = scripted(flow1, [pending, { state: "complete", accessToken: "access-token-secret", expiresIn: 3600 }]);
    const r = await runSsoLogin(conn, options);
    // Nothing listens on the port, so connecting with the new credentials fails.
    assert.equal(r.status, "error");
    assert.match(r.message, /Signed in, but connecting with the access token failed/);
    assert.match(r.message, /client_transport_error|fetch failed|ECONNREFUSED/);
    assert.ok(!r.message.includes("access-token-secret"), "token is redacted from the message");
    assert.deepEqual(conn.effectiveAuth(), { method: "sso" }, "credentials were switched");
    const used = conn.clientOptions();
    assert.equal(used.token, "access-token-secret", "the server's access token, used as is");
    assert.equal(used.subjectToken, undefined, "not a token_exchange subject token");
  });
});
