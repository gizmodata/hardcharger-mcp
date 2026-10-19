// Every way the MCP server signs in to Hardcharger, against real servers: password, a
// signed sign-in token (token_exchange, and as the password of user "token"), browser
// sign-in (login_sso, through the server's OAuth routes and a throwaway identity
// provider), and client certificates (mutual TLS). Every refusal asserts its Warp SQL error
// code, each beside a positive twin.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SignJWT, generateKeyPair } from "jose";

import { FakeIssuer } from "../helpers/fake-issuer.ts";
import { type TestCA, clientEmail, makeCAWithCleanup } from "./certs.ts";
import {
  type RunningServer,
  adminUsername,
  call,
  failsWith,
  freePort,
  launchServer,
  ok,
  passwordSettings,
  stdioClient,
  textOf,
} from "./harness.ts";

/** The audience Hardcharger accepts on sign-in tokens: the OAuth client id, as for an IdP's ID tokens. */
const CLIENT_ID = "hardcharger-mcp-test";

const clients: Client[] = [];
async function mcp(settings: Record<string, string>): Promise<Client> {
  const client = await stdioClient(settings);
  clients.push(client);
  return client;
}

after(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
});

describe("password sign-in", () => {
  let server: RunningServer;
  before(async () => {
    server = await launchServer();
  });
  after(async () => {
    await server?.stop();
  });

  it("signs in with a password containing ':' and '@'; a wrong one is invalid_credentials (401)", async () => {
    const good = await mcp(passwordSettings(server));
    const info = await ok<{ user: string; auth_method: string }>(good, "server_info");
    assert.equal(info.user, adminUsername);
    assert.equal(info.auth_method, "password");

    const bad = await mcp({ ...passwordSettings(server), HARDCHARGER_PASSWORD: "wrong" });
    const text = await failsWith(bad, "run_query", { sql: "SELECT 1" }, "invalid_credentials");
    assert.match(text, /HTTP 401/);
    assert.ok(!text.includes(server.password));
  });

  it("a TLS URI against a plain-HTTP server says to add ?tls=false (client_transport_error)", async () => {
    const tlsUri = server.uri.replace("?tls=false", "");
    const wrong = await mcp({ ...passwordSettings(server), HARDCHARGER_URI: tlsUri });
    const text = await failsWith(wrong, "run_query", { sql: "SELECT 1" }, "client_transport_error");
    assert.match(text, /speaks plain HTTP, not TLS: add \?tls=false/);
  });
});

describe("sign-in tokens and browser sign-in (an identity provider)", () => {
  const idp = new FakeIssuer();
  let server: RunningServer;
  let oauthPort = 0;
  let browserDir = "";

  const token = (claims: Record<string, unknown>) => idp.token(claims, { audience: CLIENT_ID, expiresIn: "10m" });

  before(async () => {
    await idp.start();
    oauthPort = await freePort();
    server = await launchServer({
      args: [
        "--token-allowed-issuer",
        idp.issuer,
        "--token-allowed-audience",
        CLIENT_ID,
        "--token-authorized-emails",
        "*@example.com",
        "--oauth-client-id",
        CLIENT_ID,
        "--oauth-client-secret",
        "test-client-secret",
        "--oauth-port",
        String(oauthPort),
      ],
    });
    // A "browser" for login_sso: follows the sign-in redirects as a person's browser would
    // (provider /authorize, then the server's /oauth/callback), with no login page.
    browserDir = mkdtempSync(join(tmpdir(), "hardcharger-mcp-browser-"));
    const browser = join(browserDir, "browser.mjs");
    writeFileSync(
      browser,
      `#!${process.execPath}\n` +
        "const res = await fetch(process.argv[2], { redirect: 'follow' });\n" +
        "await res.text();\n",
    );
    chmodSync(browser, 0o755);
  });

  after(async () => {
    await server?.stop();
    await idp.stop();
    rmSync(browserDir, { recursive: true, force: true });
  });

  it("HARDCHARGER_TOKEN signs in with the token_exchange grant as the token's user and role", async () => {
    const client = await mcp({ HARDCHARGER_URI: server.uri, HARDCHARGER_TOKEN: await token({ sub: "a", email: "alice@example.com", role: "admin" }) });
    const info = await ok<{ user: string; role: string; auth_method: string }>(client, "server_info");
    assert.equal(info.user, "alice@example.com");
    assert.equal(info.role, "admin");
    assert.equal(info.auth_method, "token");
  });

  it("the same token works as the password of user \"token\"", async () => {
    const client = await mcp({
      HARDCHARGER_URI: server.uri,
      HARDCHARGER_USERNAME: "token",
      HARDCHARGER_PASSWORD: await token({ sub: "c", email: "carol@example.com", role: "admin" }),
    });
    assert.equal((await ok<{ user: string }>(client, "server_info")).user, "carol@example.com");
  });

  it("a readonly token can read but not write (permission_denied), while an admin token writes", async () => {
    const admin = await mcp({
      HARDCHARGER_URI: server.uri,
      HARDCHARGER_TOKEN: await token({ sub: "a", email: "alice@example.com", role: "admin" }),
      HARDCHARGER_ALLOW_WRITES: "true",
    });
    const readonly = await mcp({
      HARDCHARGER_URI: server.uri,
      HARDCHARGER_TOKEN: await token({ sub: "r", email: "rita@example.com", role: "readonly" }),
      HARDCHARGER_ALLOW_WRITES: "true",
    });
    // The positive twin first: the same statement from an admin token succeeds.
    await ok(admin, "execute_statement", { sql: "CREATE TABLE token_written AS SELECT 1 AS x" });
    const refused = await call(readonly, "execute_statement", { sql: "CREATE TABLE token_refused AS SELECT 1 AS x" });
    assert.equal(refused.isError, true, textOf(refused));
    const why = textOf(refused);
    assert.match(why, /readonly session and cannot run statements that modify state/, why);
    assert.match(why, /\(permission_denied, SQLSTATE 42501, HTTP 403/, why);
    const read = await ok<{ rows: unknown[][] }>(readonly, "run_query", { sql: "SELECT x FROM token_written" });
    assert.deepEqual(read.rows, [[1]]);
    const missing = await call(admin, "run_query", { sql: "SELECT * FROM token_refused" });
    assert.match(textOf(missing), /sql_error/, "the readonly user's table was never created");
  });

  it("refuses a token for an unauthorized user, from another key, or for another audience (invalid_credentials)", async () => {
    const outsider = await mcp({ HARDCHARGER_URI: server.uri, HARDCHARGER_TOKEN: await token({ sub: "e", email: "eve@other.org", role: "admin" }) });
    assert.match(await failsWith(outsider, "run_query", { sql: "SELECT 1" }, "invalid_credentials"), /not authorized/);

    const { privateKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({ sub: "m", email: "mallory@example.com", role: "admin" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(idp.issuer)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
    const forger = await mcp({ HARDCHARGER_URI: server.uri, HARDCHARGER_TOKEN: forged });
    await failsWith(forger, "run_query", { sql: "SELECT 1" }, "invalid_credentials");

    const elsewhere = await mcp({
      HARDCHARGER_URI: server.uri,
      HARDCHARGER_TOKEN: await idp.token({ sub: "o", email: "olga@example.com", role: "admin" }, { audience: "another-app" }),
    });
    await failsWith(elsewhere, "run_query", { sql: "SELECT 1" }, "invalid_credentials");
  });

  it("login_sso runs the server's browser sign-in and connects with the identity token", async () => {
    idp.nextLogin = { sub: "s", email: "sso-user@example.com", role: "admin" };
    const client = await mcp({
      HARDCHARGER_URI: server.uri,
      HARDCHARGER_ENABLE_SSO: "true",
      HARDCHARGER_OAUTH_PORT: String(oauthPort),
      HARDCHARGER_BROWSER: join(browserDir, "browser.mjs"),
    });
    assert.ok((await client.listTools()).tools.some((t) => t.name === "login_sso"));
    // Before signing in there is no credential.
    await failsWith(client, "run_query", { sql: "SELECT 1" }, /has no credentials yet: call login_sso/);
    const signedIn = await ok<{ status: string }>(client, "login_sso", { wait_seconds: 30 });
    assert.equal(signedIn.status, "complete");
    const info = await ok<{ user: string; auth_method: string }>(client, "server_info");
    assert.equal(info.user, "sso-user@example.com");
    assert.equal(info.auth_method, "sso");
  });

  it("login_sso reports the provider's refusal for a user the server does not authorize", async () => {
    idp.nextLogin = { sub: "x", email: "intruder@other.org", role: "admin" };
    const client = await mcp({
      HARDCHARGER_URI: server.uri,
      HARDCHARGER_ENABLE_SSO: "true",
      HARDCHARGER_OAUTH_PORT: String(oauthPort),
      HARDCHARGER_BROWSER: join(browserDir, "browser.mjs"),
    });
    const r = await call(client, "login_sso", { wait_seconds: 30 });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal((r.structuredContent as { status: string }).status, "error");
    assert.match(textOf(r), /Browser sign-in failed: User 'intruder@other\.org' is not authorized/);
    // Still no credential: nothing was signed in.
    await failsWith(client, "run_query", { sql: "SELECT 1" }, /has no credentials yet: call login_sso/);
  });

  it("login_sso says the server offers no browser sign-in when it does not", async () => {
    const plain = await launchServer();
    try {
      const client = await mcp({
        HARDCHARGER_URI: plain.uri,
        HARDCHARGER_ENABLE_SSO: "true",
        HARDCHARGER_OAUTH_PORT: String(await freePort()),
      });
      const r = await call(client, "login_sso", { wait_seconds: 5 });
      assert.equal(r.isError, undefined, textOf(r));
      assert.equal((r.structuredContent as { status: string }).status, "unavailable");
      assert.match(textOf(r), /--oauth-client-id/);
    } finally {
      await plain.stop();
    }
  });
});

describe("client certificate sign-in (mutual TLS)", () => {
  let ca: TestCA & { remove(): void };
  let server: RunningServer;
  let dir = "";
  const files: Record<string, string> = {};

  before(async () => {
    ca = makeCAWithCleanup();
    dir = mkdtempSync(join(tmpdir(), "hardcharger-mcp-client-certs-"));
    const stranger = ca.issueClient("stranger", "stranger@example.com");
    for (const [name, pem] of Object.entries({
      "client.pem": ca.clientCertPem,
      "client-key.pem": ca.clientKeyPem,
      "stranger.pem": stranger.certPem,
      "stranger-key.pem": stranger.keyPem,
    })) {
      files[name] = join(dir, name);
      writeFileSync(files[name], pem);
    }
    server = await launchServer({
      args: [
        "--tls-cert",
        ca.serverCert,
        "--tls-key",
        ca.serverKey,
        "--mtls-ca-cert",
        ca.caFile,
        "--mtls-certificate-sign-in",
        "--mtls-admin-identities",
        clientEmail,
      ],
    });
  });

  after(async () => {
    await server?.stop();
    ca?.remove();
    rmSync(dir, { recursive: true, force: true });
  });

  const certSettings = (cert = "client.pem", key = "client-key.pem") => ({
    HARDCHARGER_URI: server.uri,
    HARDCHARGER_MTLS_CERT: files[cert]!,
    HARDCHARGER_MTLS_KEY: files[key]!,
    HARDCHARGER_TLS_ROOTS: ca.caFile,
  });

  it("the certificate is the credential: no password, the identity is its e-mail SAN", async () => {
    assert.equal(server.uri, `hardcharger://127.0.0.1:${server.port}`, "TLS by default");
    const client = await mcp(certSettings());
    const info = await ok<{ user: string; auth_method: string; tls: boolean }>(client, "server_info");
    assert.equal(info.user, clientEmail);
    assert.equal(info.auth_method, "mtls");
    assert.equal(info.tls, true);
    // A result read over several connections: each presents the certificate.
    const many = await ok<{ row_count: number }>(client, "run_query", { sql: "SELECT i FROM range(100000) t(i) ORDER BY i", max_rows: 3 });
    assert.equal(many.row_count, 3);
  });

  it("a certificate whose identity is no user is unknown_certificate_identity (401)", async () => {
    const client = await mcp(certSettings("stranger.pem", "stranger-key.pem"));
    const text = await failsWith(client, "run_query", { sql: "SELECT 1" }, "unknown_certificate_identity");
    assert.match(text, /HTTP 401/);
  });

  it("without the server's CA the handshake fails (client_transport_error); skipping verification connects", async () => {
    const { HARDCHARGER_TLS_ROOTS: _roots, ...noRoots } = certSettings();
    const untrusted = await mcp(noRoots);
    await failsWith(untrusted, "run_query", { sql: "SELECT 1" }, "client_transport_error");
    const skipping = await mcp({ ...noRoots, HARDCHARGER_TLS_SKIP_VERIFY: "true" });
    assert.equal((await ok<{ user: string }>(skipping, "server_info")).user, clientEmail);
  });

  it("a password over the same TLS server signs in as that user, the certificate only admitting the connection", async () => {
    const client = await mcp({ ...certSettings(), HARDCHARGER_USERNAME: adminUsername, HARDCHARGER_PASSWORD: server.password });
    const info = await ok<{ user: string; auth_method: string }>(client, "server_info");
    assert.equal(info.user, adminUsername);
    assert.equal(info.auth_method, "password");
  });
});
