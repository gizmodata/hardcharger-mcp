import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { after, before, describe, it } from "node:test";

import { HardchargerConnection, parseConfig } from "../../dist/connection.js";
import { httpGetJson, runSsoLogin, type JsonResponse, type SsoOptions } from "../../dist/sso.js";

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

function connection(port: number, oauthPort = port): HardchargerConnection {
  const cfg = parseConfig({
    HARDCHARGER_URI: `hardcharger://127.0.0.1:${port}?tls=false`,
    HARDCHARGER_OAUTH_PORT: String(oauthPort),
    HARDCHARGER_ENABLE_SSO: "true",
  });
  return new HardchargerConnection(cfg.connections[0], () => {});
}

const ok = (body: Record<string, unknown>): JsonResponse => ({ status: 200, body });

/** Scripted sign-in server: the initiate response and a queue of poll responses. */
function scripted(initiate: JsonResponse, polls: JsonResponse[]) {
  const calls: string[] = [];
  const opened: string[] = [];
  const options: SsoOptions = {
    waitSeconds: 1,
    pollIntervalMs: 1,
    getJson: async (url) => {
      calls.push(url);
      if (url.endsWith("/oauth/initiate")) return initiate;
      const next = polls.shift();
      if (!next) throw new Error("no scripted poll response left");
      return next;
    },
    openUrl: async (url) => {
      opened.push(url);
    },
  };
  return { options, calls, opened, initiates: () => calls.filter((u) => u.endsWith("/oauth/initiate")).length };
}

const initiateOk = ok({ session_uuid: "sess-1", auth_url: "https://idp.test/authorize?state=abc" });

describe("runSsoLogin", () => {
  let port = 0;
  before(async () => {
    port = await closedPort();
  });

  it("reports unavailable when nothing listens on the server's OAuth port", async () => {
    const r = await runSsoLogin(connection(port), { waitSeconds: 1, openUrl: async () => {} });
    assert.equal(r.status, "unavailable");
    assert.match(r.message, new RegExp(`no browser sign-in at http://127\\.0\\.0\\.1:${port}`));
    assert.match(r.message, /--oauth-client-id/);
  });

  it("reports unavailable for a 404 from /oauth/initiate", async () => {
    const { options } = scripted({ status: 404, body: { status: "not_found" } }, []);
    const r = await runSsoLogin(connection(port), options);
    assert.equal(r.status, "unavailable");
  });

  it("fails cleanly on a malformed initiate response", async () => {
    const { options } = scripted(ok({ nope: true }), []);
    const r = await runSsoLogin(connection(port), options);
    assert.equal(r.status, "error");
    assert.match(r.message, /Unexpected response from \/oauth\/initiate \(HTTP 200\)/);
  });

  it("opens the browser, polls, and returns pending with the URL when the user has not finished", async () => {
    const { options, opened, calls } = scripted(initiateOk, Array(50).fill(ok({ status: "pending" })));
    const r = await runSsoLogin(connection(port, 31339), { ...options, waitSeconds: 0.05 });
    assert.equal(r.status, "pending");
    assert.equal(r.authUrl, initiateOk.body.auth_url);
    assert.match(r.message, /open this URL: https:\/\/idp\.test\/authorize/);
    assert.deepEqual(opened, [initiateOk.body.auth_url]);
    assert.equal(calls[0], "http://127.0.0.1:31339/oauth/initiate", "http(s)://<host>:<oauth port>, as the CLI derives it");
    assert.ok(calls.slice(1).every((u) => u === "http://127.0.0.1:31339/oauth/token/sess-1"));
  });

  it("resumes a pending session on the next call instead of starting a new one", async () => {
    const conn = connection(port);
    const first = scripted(initiateOk, Array(50).fill(ok({ status: "pending" })));
    await runSsoLogin(conn, { ...first.options, waitSeconds: 0.02 });
    const second = scripted(ok({ session_uuid: "would-be-new", auth_url: "https://idp.test/new" }), [
      ok({ status: "error", error: "denied" }),
    ]);
    const r = await runSsoLogin(conn, second.options);
    assert.equal(second.initiates(), 0, "no new sign-in started");
    assert.deepEqual(second.opened, [], "browser not re-opened");
    assert.ok(second.calls.every((u) => u.endsWith("/oauth/token/sess-1")), "polls the original session");
    assert.equal(r.status, "error");
    assert.match(r.message, /Browser sign-in failed: denied/);
  });

  it("maps a 404 poll (expired or used) and unexpected statuses to errors and forgets the session", async () => {
    const conn = connection(port);
    const nf = scripted(initiateOk, [{ status: 404, body: { status: "not_found" } }]);
    const r1 = await runSsoLogin(conn, nf.options);
    assert.equal(r1.status, "error");
    assert.match(r1.message, /expired or was already used/);
    const weird = scripted(initiateOk, [ok({ status: "bogus" })]);
    const r2 = await runSsoLogin(conn, weird.options);
    assert.equal(weird.initiates(), 1, "a fresh sign-in is started after the previous one was forgotten");
    assert.equal(r2.status, "error");
    assert.match(r2.message, /Unexpected sign-in poll answer \(HTTP 200\): \{"status":"bogus"\}/);
  });

  it("rejects a 'complete' poll without a token", async () => {
    const { options } = scripted(initiateOk, [ok({ status: "complete" })]);
    const r = await runSsoLogin(connection(port), options);
    assert.equal(r.status, "error");
    assert.match(r.message, /no token/);
  });

  it("switches to the identity token on completion and reports a connect failure without leaking it", async () => {
    const conn = connection(port);
    const { options } = scripted(initiateOk, [ok({ status: "pending" }), ok({ status: "complete", token: "id-token-secret" })]);
    const r = await runSsoLogin(conn, options);
    // Nothing listens on the port, so connecting with the new credentials fails.
    assert.equal(r.status, "error");
    assert.match(r.message, /Signed in, but connecting with the identity token failed/);
    assert.match(r.message, /transport_error|fetch failed|ECONNREFUSED/);
    assert.ok(!r.message.includes("id-token-secret"), "token is redacted from the message");
    assert.deepEqual(conn.effectiveAuth(), { method: "sso" }, "credentials were switched");
    assert.equal(conn.clientOptions().subjectToken, "id-token-secret", "the ID token is the token_exchange grant");
  });
});

describe("httpGetJson", () => {
  let server: http.Server;
  let origin = "";
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "pending" }));
      } else if (req.url === "/gone") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "not_found" }));
      } else {
        res.writeHead(502, { "content-type": "text/html" });
        res.end("<html>bad gateway</html>");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("parses JSON with the status code and rejects non-JSON", async () => {
    assert.deepEqual(await httpGetJson(`${origin}/json`, false), { status: 200, body: { status: "pending" } });
    assert.deepEqual(await httpGetJson(`${origin}/gone`, false), { status: 404, body: { status: "not_found" } });
    await assert.rejects(httpGetJson(`${origin}/html`, false), /Unexpected non-JSON response \(HTTP 502\)/);
  });
});
