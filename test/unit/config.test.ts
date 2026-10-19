import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { HardchargerError } from "@gizmodata/hardcharger";

import {
  ConfigError,
  DEFAULTS,
  HardchargerConnection,
  authMethod,
  envKey,
  isConnectionLost,
  parseBoolean,
  parseConfig,
  redactSecrets,
} from "../../dist/connection.js";
import { ConnectionRegistry } from "../../dist/registry.js";

const base = {
  HARDCHARGER_URI: "hardcharger://db.internal",
  HARDCHARGER_USERNAME: "alice",
  HARDCHARGER_PASSWORD: "p@ss:word",
};

const hcError = (code: string, extra: Record<string, unknown> = {}) =>
  new HardchargerError({ code, message: `boom (${code})`, ...extra } as ConstructorParameters<typeof HardchargerError>[0]);

describe("parseConfig", () => {
  const first = (env: Record<string, string>) => parseConfig(env).connections[0];

  it("applies defaults: TLS to port 31337", () => {
    const cfg = parseConfig({ ...base });
    const c = cfg.connections[0];
    assert.equal(cfg.connections.length, 1);
    assert.equal(c.name, DEFAULTS.connectionName);
    assert.equal(c.uri, "hardcharger://db.internal");
    assert.equal(c.host, "db.internal");
    assert.equal(c.port, 31337);
    assert.equal(c.tls, true);
    assert.equal(c.username, "alice");
    assert.equal(c.password, "p@ss:word");
    assert.equal(c.tlsSkipVerify, false);
    assert.equal(c.queryTimeoutSeconds, DEFAULTS.queryTimeoutSeconds);
    assert.equal(authMethod(c), "password");
    assert.equal(cfg.allowWrites, false);
    assert.equal(cfg.maxRows, DEFAULTS.maxRows);
    assert.equal(cfg.maxCellChars, DEFAULTS.maxCellChars);
    assert.equal(cfg.queryTimeoutSeconds, DEFAULTS.queryTimeoutSeconds);
    assert.equal(cfg.mcpBearerToken, undefined);
    assert.equal(cfg.enableSso, false);
  });

  it("parses overrides", () => {
    const cfg = parseConfig({
      HARDCHARGER_URI: "hardcharger://h:31338?tls=false",
      HARDCHARGER_USERNAME: "token",
      HARDCHARGER_PASSWORD: "jwt",
      HARDCHARGER_TLS_SKIP_VERIFY: "1",
      HARDCHARGER_ALLOW_WRITES: "yes",
      HARDCHARGER_MAX_ROWS: "10",
      HARDCHARGER_MAX_CELL_CHARS: "50",
      HARDCHARGER_QUERY_TIMEOUT_SECONDS: "0",
      HARDCHARGER_MCP_BEARER_TOKEN: "bearer",
      HARDCHARGER_CONNECTION_NAME: "prod",
    });
    const c = cfg.connections[0];
    assert.equal(c.name, "prod");
    assert.equal(c.port, 31338);
    assert.equal(c.tls, false);
    assert.equal(c.username, "token");
    assert.equal(c.password, "jwt");
    assert.equal(c.tlsSkipVerify, true);
    assert.equal(c.queryTimeoutSeconds, 0);
    assert.equal(cfg.allowWrites, true);
    assert.equal(cfg.maxRows, 10);
    assert.equal(cfg.maxCellChars, 50);
    assert.equal(cfg.queryTimeoutSeconds, 0);
    assert.equal(cfg.mcpBearerToken, "bearer");
  });

  it("requires a URI and a credential", () => {
    assert.throws(() => parseConfig({}), /HARDCHARGER_URI is required/);
    assert.throws(() => parseConfig({ HARDCHARGER_URI: "hardcharger://h" }), /no credentials/);
    assert.throws(() => parseConfig({ HARDCHARGER_URI: "hardcharger://h" }), /HARDCHARGER_MTLS_CERT \+ HARDCHARGER_MTLS_KEY/);
    assert.throws(() => parseConfig({ HARDCHARGER_URI: "hardcharger://h", HARDCHARGER_USERNAME: "u" }), /must be set together/);
    assert.throws(() => parseConfig({ HARDCHARGER_URI: "hardcharger://h", HARDCHARGER_PASSWORD: "p" }), /must be set together/);
    assert.throws(
      () => parseConfig({ ...base, HARDCHARGER_TOKEN: "jwt" }),
      /either HARDCHARGER_USERNAME\/HARDCHARGER_PASSWORD or HARDCHARGER_TOKEN, not both/,
    );
    assert.throws(
      () => parseConfig({ HARDCHARGER_URI: "hardcharger://h", HARDCHARGER_MTLS_CERT: "c.pem" }),
      /HARDCHARGER_MTLS_CERT and HARDCHARGER_MTLS_KEY must be set together/,
    );
  });

  it("refuses URIs the client would refuse, in Hardcharger's words, before anything is sent", () => {
    assert.throws(() => parseConfig({ ...base, HARDCHARGER_URI: "gizmosql://h:31337" }), ConfigError);
    assert.throws(() => parseConfig({ ...base, HARDCHARGER_URI: "hardcharger+http://h" }), /HARDCHARGER_URI: .*not a Hardcharger URI scheme/);
    assert.throws(() => parseConfig({ ...base, HARDCHARGER_URI: "jdbc:hardcharger://h" }), /HARDCHARGER_URI: .*drop the jdbc: prefix/);
    assert.throws(() => parseConfig({ ...base, HARDCHARGER_URI: "hardcharger://u:p@h" }), ConfigError);
    assert.throws(() => parseConfig({ ...base, HARDCHARGER_URI: "hardcharger://h?useEncryption=false" }), /useEncryption/);
  });

  it("selects the sign-in from the credential given", () => {
    assert.equal(authMethod(first({ HARDCHARGER_URI: "hardcharger://h", HARDCHARGER_TOKEN: "jwt" })), "token");
    const mtls = first({ HARDCHARGER_URI: "hardcharger://h", HARDCHARGER_MTLS_CERT: "c.pem", HARDCHARGER_MTLS_KEY: "k.pem" });
    assert.equal(authMethod(mtls), "mtls");
    // A password beside a client certificate: the certificate only admits the connection.
    const both = first({ ...base, HARDCHARGER_MTLS_CERT: "c.pem", HARDCHARGER_MTLS_KEY: "k.pem" });
    assert.equal(authMethod(both), "password");
  });

  it("refuses a client certificate or TLS roots on a plain-HTTP URI", () => {
    assert.throws(
      () => parseConfig({ HARDCHARGER_URI: "hardcharger://h?tls=false", HARDCHARGER_MTLS_CERT: "c", HARDCHARGER_MTLS_KEY: "k" }),
      /HARDCHARGER_MTLS_CERT needs TLS/,
    );
    assert.throws(
      () => parseConfig({ ...base, HARDCHARGER_URI: "hardcharger://h?tls=false", HARDCHARGER_TLS_ROOTS: "ca.pem" }),
      /HARDCHARGER_TLS_ROOTS needs TLS/,
    );
  });

  it("allows an empty password when the username is set", () => {
    const c = first({ HARDCHARGER_URI: "hardcharger://h", HARDCHARGER_USERNAME: "u", HARDCHARGER_PASSWORD: "" });
    assert.equal(c.username, "u");
    assert.equal(c.password, "");
  });

  it("treats unsubstituted MCPB placeholders as unset (Claude Desktop passes them for blank fields)", () => {
    const c = first({
      HARDCHARGER_URI: "hardcharger://h",
      HARDCHARGER_USERNAME: "u",
      HARDCHARGER_PASSWORD: "p",
      HARDCHARGER_TOKEN: "${user_config.token}",
      HARDCHARGER_MTLS_CERT: "${user_config.mtls_cert}",
      HARDCHARGER_MTLS_KEY: "${user_config.mtls_key}",
      HARDCHARGER_TLS_SKIP_VERIFY: "${user_config.tls_skip_verify}",
      HARDCHARGER_2_URI: "${user_config.connection2_uri}",
      HARDCHARGER_2_NAME: "${user_config.connection2_name}",
    });
    assert.equal(c.username, "u");
    assert.equal(c.token, undefined);
    assert.equal(c.mtlsCertFile, undefined);
    assert.equal(c.tlsSkipVerify, false);
    assert.throws(
      () => parseConfig({ HARDCHARGER_URI: "hardcharger://h", HARDCHARGER_USERNAME: "${user_config.username}", HARDCHARGER_PASSWORD: "${user_config.password}" }),
      /no credentials/,
    );
    assert.throws(() => parseConfig({ HARDCHARGER_URI: "${user_config.uri}" }), /HARDCHARGER_URI is required/);
  });

  it("parses optional default catalog/schema", () => {
    const c = first({ ...base });
    assert.equal(c.defaultCatalog, undefined);
    assert.equal(c.defaultSchema, undefined);
    const d = first({ ...base, HARDCHARGER_DEFAULT_CATALOG: "lake", HARDCHARGER_DEFAULT_SCHEMA: " sales " });
    assert.equal(d.defaultCatalog, "lake");
    assert.equal(d.defaultSchema, "sales");
  });

  it("allows no credentials when SSO is enabled", () => {
    const cfg = parseConfig({ HARDCHARGER_URI: "hardcharger://h", HARDCHARGER_ENABLE_SSO: "true" });
    assert.equal(cfg.enableSso, true);
    assert.equal(cfg.connections[0].username, undefined);
  });

  it("validates numbers and booleans", () => {
    assert.throws(() => parseConfig({ ...base, HARDCHARGER_MAX_ROWS: "0" }), ConfigError);
    assert.throws(() => parseConfig({ ...base, HARDCHARGER_MAX_ROWS: "abc" }), ConfigError);
    assert.throws(() => parseConfig({ ...base, HARDCHARGER_ALLOW_WRITES: "maybe" }), ConfigError);
    assert.equal(parseBoolean("X", "OFF", true), false);
    assert.equal(parseBoolean("X", undefined, true), true);
  });

  describe("multiple connections", () => {
    it("reads the manifest slots 2 and 3 with default names", () => {
      const cfg = parseConfig({
        ...base,
        HARDCHARGER_2_URI: "hardcharger://h2:444",
        HARDCHARGER_2_TOKEN: "jwt2",
        HARDCHARGER_2_DEFAULT_CATALOG: "lake",
        HARDCHARGER_3_URI: "hardcharger://h3?tls=false",
        HARDCHARGER_3_NAME: "Staging",
        HARDCHARGER_3_USERNAME: "u3",
        HARDCHARGER_3_PASSWORD: "p3",
      });
      assert.deepEqual(cfg.connections.map((c) => c.name), ["default", "server2", "Staging"]);
      assert.equal(cfg.connections[1].token, "jwt2");
      assert.equal(cfg.connections[1].port, 444);
      assert.equal(cfg.connections[1].defaultCatalog, "lake");
      assert.equal(cfg.connections[2].tls, false);
      assert.equal(cfg.connections[2].queryTimeoutSeconds, DEFAULTS.queryTimeoutSeconds);
    });

    it("ignores slots without a URI", () => {
      const cfg = parseConfig({ ...base, HARDCHARGER_2_NAME: "ghost", HARDCHARGER_2_PASSWORD: "x", HARDCHARGER_3_TOKEN: "1" });
      assert.equal(cfg.connections.length, 1);
    });

    it("reads HARDCHARGER_CONNECTIONS names from HARDCHARGER_<NAME>_* variables", () => {
      const cfg = parseConfig({
        ...base,
        HARDCHARGER_CONNECTIONS: "prod, dev-eu",
        HARDCHARGER_PROD_URI: "hardcharger://prod.internal",
        HARDCHARGER_PROD_TOKEN: "pt",
        HARDCHARGER_DEV_EU_URI: "hardcharger://dev.internal",
        HARDCHARGER_DEV_EU_USERNAME: "d",
        HARDCHARGER_DEV_EU_PASSWORD: "dp",
        HARDCHARGER_DEV_EU_NAME: "dev",
      });
      assert.deepEqual(cfg.connections.map((c) => c.name), ["default", "prod", "dev"]);
      assert.equal(envKey("dev-eu"), "DEV_EU");
    });

    it("refuses a listed connection named mcp (HARDCHARGER_MCP_* is the HTTP transport's)", () => {
      assert.throws(() => parseConfig({ ...base, HARDCHARGER_CONNECTIONS: "mcp" }), /"mcp" is reserved/);
    });

    it("a listed connection without a URI is ignored, and the primary may be absent when others exist", () => {
      const cfg = parseConfig({ HARDCHARGER_CONNECTIONS: "prod", HARDCHARGER_PROD_URI: "hardcharger://p", HARDCHARGER_PROD_USERNAME: "u", HARDCHARGER_PROD_PASSWORD: "t" });
      assert.deepEqual(cfg.connections.map((c) => c.name), ["prod"]);
    });

    it("validates every connection and rejects duplicate names", () => {
      assert.throws(
        () => parseConfig({ ...base, HARDCHARGER_2_URI: "hardcharger://h2" }),
        /Connection "server2" \(HARDCHARGER_2_URI\) has no credentials/,
      );
      assert.throws(
        () => parseConfig({ ...base, HARDCHARGER_2_URI: "hardcharger://h2", HARDCHARGER_2_USERNAME: "u", HARDCHARGER_2_PASSWORD: "t", HARDCHARGER_2_NAME: "DEFAULT" }),
        /used more than once/,
      );
      assert.throws(
        () => parseConfig({ ...base, HARDCHARGER_2_URI: "hardcharger://h2", HARDCHARGER_2_USERNAME: "u", HARDCHARGER_2_PASSWORD: "t", HARDCHARGER_2_NAME: "bad name!" }),
        /must be 1-64 letters/,
      );
    });
  });
});

describe("client options", () => {
  const options = (env: Record<string, string>) =>
    new HardchargerConnection(parseConfig(env).connections[0], () => undefined).clientOptions();

  it("password, token and certificate sign-in map onto the client's credentials", () => {
    const pw = options({ ...base });
    assert.equal(pw.url, "hardcharger://db.internal");
    assert.equal(pw.username, "alice");
    assert.equal(pw.password, "p@ss:word");
    assert.equal(pw.subjectToken, undefined);
    assert.equal(pw.authType, undefined);

    const tok = options({ HARDCHARGER_URI: "hardcharger://h", HARDCHARGER_TOKEN: "jwt" });
    assert.equal(tok.subjectToken, "jwt", "a sign-in token is the token_exchange grant");
    assert.equal(tok.username, undefined);

    const dir = mkdtempSync(join(tmpdir(), "hardcharger-mcp-unit-"));
    try {
      for (const f of ["c.pem", "k.pem", "ca.pem"]) writeFileSync(join(dir, f), `PEM ${f}`);
      const mtls = options({
        HARDCHARGER_URI: "hardcharger://h",
        HARDCHARGER_MTLS_CERT: join(dir, "c.pem"),
        HARDCHARGER_MTLS_KEY: join(dir, "k.pem"),
        HARDCHARGER_TLS_ROOTS: join(dir, "ca.pem"),
      });
      assert.equal(mtls.authType, "mtls");
      assert.deepEqual(mtls.tls, { ca: "PEM ca.pem", cert: "PEM c.pem", key: "PEM k.pem" });
      assert.equal(mtls.username, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.throws(
      () => options({ HARDCHARGER_URI: "hardcharger://h", HARDCHARGER_MTLS_CERT: "/nonexistent/c.pem", HARDCHARGER_MTLS_KEY: "/nonexistent/k.pem" }),
      /Cannot read the client certificate file \/nonexistent\/c.pem/,
    );
  });

  it("sends no TLS options over plain HTTP and skips verification only when asked", () => {
    assert.equal(options({ ...base, HARDCHARGER_URI: "hardcharger://h?tls=false", HARDCHARGER_TLS_SKIP_VERIFY: "true" }).tls, undefined);
    assert.deepEqual(options({ ...base, HARDCHARGER_TLS_SKIP_VERIFY: "true" }).tls, { skipVerify: true });
    assert.equal(options({ ...base }).tls, undefined);
  });

  it("runs browser sign-in on the connection's own URI, with its TLS settings", () => {
    const conn = (env: Record<string, string>) => new HardchargerConnection(parseConfig(env).connections[0], () => undefined);
    assert.deepEqual(conn({ ...base }).signInTarget(), { url: base.HARDCHARGER_URI });
    assert.deepEqual(conn({ ...base, HARDCHARGER_URI: "hardcharger://db?tls=false" }).signInTarget(), {
      url: "hardcharger://db?tls=false",
    });
    assert.deepEqual(conn({ ...base, HARDCHARGER_TLS_SKIP_VERIFY: "true" }).signInTarget(), {
      url: base.HARDCHARGER_URI,
      tls: { skipVerify: true },
    });
  });
});

describe("redaction", () => {
  it("redacts raw and URL-encoded secrets from messages", () => {
    const msg = "auth failed for p@ss word / p%40ss%20word / tok";
    assert.equal(redactSecrets(msg, ["p@ss word", "tok", undefined, ""]), "auth failed for *** / *** / ***");
  });

  it("connection.redact covers configured secrets, tokens included", () => {
    const cfg = parseConfig({ ...base, HARDCHARGER_MCP_BEARER_TOKEN: "bearer-xyz", HARDCHARGER_2_URI: "hardcharger://h2", HARDCHARGER_2_TOKEN: "jwt-secret" });
    const conn = new HardchargerConnection(cfg.connections[0], () => undefined);
    assert.equal(conn.redact("pw=p@ss:word bearer-xyz"), "pw=*** bearer-xyz");
    const registry = new ConnectionRegistry(cfg, () => undefined);
    assert.equal(registry.redact("pw=p@ss:word bearer-xyz jwt-secret"), "pw=*** *** ***");
    assert.equal(registry.current(), "default");
    assert.throws(() => registry.get("nope"), /Unknown connection "nope". Available connections: default, server2/);
    assert.equal(registry.get("DEFAULT").config.name, "default");
    const summary = registry.summaries()[1];
    assert.equal(summary.uri, "hardcharger://h2");
    assert.equal(summary.auth, "token");
  });
});

describe("isConnectionLost", () => {
  it("reopens for a session an administrator ended, a closed connection, and transport failures", () => {
    assert.equal(isConnectionLost(hcError("session_ended", { reason: "killed" })), true);
    assert.equal(isConnectionLost(hcError("session_not_found")), true);
    assert.equal(isConnectionLost(hcError("client_connection_closed")), true);
    assert.equal(isConnectionLost(hcError("client_transport_error")), true);
  });

  it("never retries a refused credential or a SQL error", () => {
    assert.equal(isConnectionLost(hcError("invalid_credentials")), false);
    assert.equal(isConnectionLost(hcError("invalid_token")), false);
    assert.equal(isConnectionLost(hcError("unknown_certificate_identity")), false);
    assert.equal(isConnectionLost(hcError("sql_error")), false);
    assert.equal(isConnectionLost(hcError("statement_timeout")), false);
    assert.equal(isConnectionLost(new Error("session_ended")), false, "only the client's coded errors count");
  });

  it("reopens a session ended for an expired token, without a reason or for a reason it doesn't know", () => {
    assert.equal(isConnectionLost(hcError("session_ended", { reason: "token_expired" })), true);
    assert.equal(isConnectionLost(hcError("session_ended")), true);
    assert.equal(isConnectionLost(hcError("session_ended", { reason: "some_later_reason" })), true);
  });

  it("never reopens a session ended because the sign-in was withdrawn (Warp SQL 4.2, 5.6)", () => {
    for (const reason of ["token_revoked", "credentials_changed", "principal_dropped"]) {
      assert.equal(isConnectionLost(hcError("session_ended", { reason })), false, reason);
    }
  });

  it("knows only the Warp SQL 1.0 client codes, not the old unprefixed ones", () => {
    assert.equal(isConnectionLost(hcError("transport_error")), false);
    assert.equal(isConnectionLost(hcError("connection_closed")), false);
  });
});
