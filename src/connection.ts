// Configuration parsing, credential redaction, and the lazily opened Hardcharger
// connection behind each configured server.

import { readFileSync } from "node:fs";

import {
  type BrowserSignInTarget,
  type Connection,
  type ConnectOptions,
  HardchargerError,
  HardchargerErrorCode,
  connect as hardchargerConnect,
  parseUrl,
} from "@gizmodata/hardcharger";
import { Table, type RecordBatch } from "apache-arrow";

import type { OAuthConfig } from "./oauth.js";
import type { BoundParams } from "./params.js";

/** How a connection signs in. */
export type AuthMethod = "password" | "token" | "mtls" | "sso" | "none";

/** Settings for one Hardcharger server. */
export interface ConnectionConfig {
  /** Unique, case-insensitive name used in tool arguments (e.g. "default", "prod"). */
  name: string;
  /** `hardcharger://host[:port][/prefix][?tls=false]` (TLS unless `?tls=false`, port 31337 by default). */
  uri: string;
  /** Host and TLS of `uri`, as the client reads it. */
  host: string;
  port: number;
  tls: boolean;
  /** Password sign-in. */
  username?: string;
  password?: string;
  /** A signed sign-in token (an identity provider's ID token, or one minted for Hardcharger): the token_exchange grant. */
  token?: string;
  /** Client certificate and key (PEM file paths) for mutual TLS. Alone, the certificate is the credential. */
  mtlsCertFile?: string;
  mtlsKeyFile?: string;
  /** CA bundle (PEM file path) that verifies the server's certificate, for a private CA. */
  tlsRootsFile?: string;
  tlsSkipVerify: boolean;
  /** Catalog to use at session start (optional). */
  defaultCatalog?: string;
  /** Schema to use at session start (optional). */
  defaultSchema?: string;
  /** Per-statement timeout applied to this connection's statements (0 = none). */
  queryTimeoutSeconds: number;
}

/** Whole-server settings plus every configured connection (the first is the initial default). */
export interface McpConfig {
  connections: ConnectionConfig[];
  allowWrites: boolean;
  maxRows: number;
  maxCellChars: number;
  queryTimeoutSeconds: number;
  /** Bearer token required on every Streamable HTTP request (http transport only). */
  mcpBearerToken?: string;
  /** OAuth resource-server settings for the HTTP transport (set when HARDCHARGER_MCP_OAUTH_ISSUER is configured). */
  mcpOAuth?: OAuthConfig;
  /** HTTP transport with OAuth: seconds a per-user session may sit idle before its connections are closed. */
  mcpSessionIdleSeconds: number;
  /** HTTP transport with OAuth: cap on concurrent per-user sessions (least recently used is closed first). */
  mcpMaxSessions: number;
  /** Enables the optional `login_sso` tool (the server's OAuth browser sign-in). */
  enableSso: boolean;
}

export const DEFAULTS = {
  maxRows: 500,
  maxCellChars: 200,
  queryTimeoutSeconds: 60,
  connectionName: "default",
  sessionIdleSeconds: 1800,
  maxSessions: 200,
} as const;

/** Extra connection slots the Claude Desktop manifest exposes (`HARDCHARGER_2_*`, `HARDCHARGER_3_*`). */
export const MANIFEST_SLOTS = ["2", "3"] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", ""]);

/**
 * Unsubstituted MCPB template placeholders. Claude Desktop passes the
 * literal `${user_config.<key>}` for optional settings the user left
 * blank, which must count as "not set".
 */
const TEMPLATE_PLACEHOLDER = /^\$\{[^}]*\}$/u;

/** True when an env value should be treated as absent. */
export function isUnset(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim();
  return v === "" || TEMPLATE_PLACEHOLDER.test(v);
}

export function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (isUnset(raw)) return fallback;
  const v = raw!.trim().toLowerCase();
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  throw new ConfigError(`${name} must be true/false (got "${raw}").`);
}

export function parseInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  { min, max }: { min: number; max?: number },
): number {
  if (isUnset(raw)) return fallback;
  const n = Number(raw!.trim());
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
    throw new ConfigError(`${name} must be an integer ${range} (got "${raw}").`);
  }
  return n;
}

function nonEmpty(raw: string | undefined): string | undefined {
  return isUnset(raw) ? undefined : raw!.trim();
}

/** Env-variable key fragment for a connection key: `prod-eu` -> `PROD_EU`. */
export function envKey(key: string): string {
  return key.trim().toUpperCase().replace(/[^A-Z0-9]+/gu, "_");
}

/** Reads and validates a `hardcharger://` URI the way the client will (throws ConfigError). */
export function parseHardchargerUri(name: string, raw: string): { uri: string; host: string; port: number; tls: boolean } {
  let base: URL;
  try {
    base = parseUrl(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message.replace(/^\[hardcharger\] /u, "") : String(err);
    throw new ConfigError(`${name}: ${message}`);
  }
  const tls = base.protocol === "https:";
  const host = base.hostname.replace(/^\[(.*)\]$/u, "$1");
  return { uri: raw.trim(), host, port: Number(base.port || (tls ? 443 : 80)), tls };
}

/**
 * Parses one connection from `env` using variables named `<prefix>URI`,
 * `<prefix>USERNAME`, ... (prefix `HARDCHARGER_` for the primary connection,
 * `HARDCHARGER_<KEY>_` for additional ones). Returns null when no URI is set.
 */
function parseConnection(
  env: NodeJS.ProcessEnv,
  prefix: string,
  defaultName: string,
  globals: { queryTimeoutSeconds: number; enableSso: boolean },
): ConnectionConfig | null {
  const v = (suffix: string) => env[`${prefix}${suffix}`];
  const rawUri = nonEmpty(v("URI"));
  if (!rawUri) return null;
  const name = nonEmpty(v("NAME")) ?? defaultName;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) {
    throw new ConfigError(
      `Connection name "${name}" (${prefix}NAME) must be 1-64 letters, digits, dots, dashes or underscores.`,
    );
  }
  const target = parseHardchargerUri(`${prefix}URI`, rawUri);

  const username = nonEmpty(v("USERNAME"));
  const rawPassword = v("PASSWORD");
  const password = isUnset(rawPassword) && rawPassword !== "" ? undefined : rawPassword;
  const token = nonEmpty(v("TOKEN"));
  const mtlsCertFile = nonEmpty(v("MTLS_CERT"));
  const mtlsKeyFile = nonEmpty(v("MTLS_KEY"));
  const tlsRootsFile = nonEmpty(v("TLS_ROOTS"));

  const hasPassword = username !== undefined || (password !== undefined && password !== "");
  if (hasPassword && (username === undefined || password === undefined)) {
    throw new ConfigError(`Connection "${name}": ${prefix}USERNAME and ${prefix}PASSWORD must be set together.`);
  }
  if (hasPassword && token !== undefined) {
    throw new ConfigError(
      `Connection "${name}": set either ${prefix}USERNAME/${prefix}PASSWORD or ${prefix}TOKEN, not both.`,
    );
  }
  if ((mtlsCertFile === undefined) !== (mtlsKeyFile === undefined)) {
    throw new ConfigError(`Connection "${name}": ${prefix}MTLS_CERT and ${prefix}MTLS_KEY must be set together.`);
  }
  const hasCertificate = mtlsCertFile !== undefined;
  if ((hasCertificate || tlsRootsFile !== undefined) && !target.tls) {
    throw new ConfigError(
      `Connection "${name}": ${hasCertificate ? `${prefix}MTLS_CERT` : `${prefix}TLS_ROOTS`} needs TLS, ` +
        `but ${prefix}URI says ?tls=false.`,
    );
  }
  if (!hasPassword && token === undefined && !hasCertificate && !globals.enableSso) {
    throw new ConfigError(
      `Connection "${name}" (${prefix}URI) has no credentials: set ${prefix}USERNAME + ${prefix}PASSWORD, ` +
        `${prefix}TOKEN (a signed sign-in token), ${prefix}MTLS_CERT + ${prefix}MTLS_KEY (client certificate ` +
        "sign-in), or HARDCHARGER_ENABLE_SSO=true to sign in with the login_sso tool.",
    );
  }
  return {
    name,
    ...target,
    username: hasPassword ? username : undefined,
    password: hasPassword ? password : undefined,
    token,
    mtlsCertFile,
    mtlsKeyFile,
    tlsRootsFile,
    tlsSkipVerify: parseBoolean(`${prefix}TLS_SKIP_VERIFY`, v("TLS_SKIP_VERIFY"), false),
    defaultCatalog: nonEmpty(v("DEFAULT_CATALOG")),
    defaultSchema: nonEmpty(v("DEFAULT_SCHEMA")),
    queryTimeoutSeconds: globals.queryTimeoutSeconds,
  };
}

/**
 * Builds the effective configuration from environment variables.
 *
 * Connections:
 * - primary: `HARDCHARGER_URI` etc. (name `HARDCHARGER_CONNECTION_NAME`, default "default");
 * - manifest slots: `HARDCHARGER_2_URI` / `HARDCHARGER_3_URI` etc. (names `HARDCHARGER_2_NAME`,
 *   default "server2"/"server3");
 * - any names listed in `HARDCHARGER_CONNECTIONS` (comma separated), read from
 *   `HARDCHARGER_<NAME>_URI` etc. with the name upper-cased and non-alphanumerics
 *   replaced by `_`.
 * Slots without a URI are ignored. At least one connection is required.
 */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const enableSso = parseBoolean("HARDCHARGER_ENABLE_SSO", env.HARDCHARGER_ENABLE_SSO, false);
  const queryTimeoutSeconds = parseInteger(
    "HARDCHARGER_QUERY_TIMEOUT_SECONDS",
    env.HARDCHARGER_QUERY_TIMEOUT_SECONDS,
    DEFAULTS.queryTimeoutSeconds,
    { min: 0, max: 86400 },
  );
  const globals = { queryTimeoutSeconds, enableSso };

  const connections: ConnectionConfig[] = [];
  const primary = parseConnection(
    env,
    "HARDCHARGER_",
    nonEmpty(env.HARDCHARGER_CONNECTION_NAME) ?? DEFAULTS.connectionName,
    globals,
  );
  if (primary) connections.push(primary);

  const extraKeys: Array<{ key: string; defaultName: string }> = MANIFEST_SLOTS.map((slot) => ({
    key: slot,
    defaultName: `server${slot}`,
  }));
  for (const listed of (nonEmpty(env.HARDCHARGER_CONNECTIONS) ?? "").split(",")) {
    const key = listed.trim();
    if (!key) continue;
    if (envKey(key) === "MCP") {
      throw new ConfigError(`HARDCHARGER_CONNECTIONS: "${key}" is reserved (HARDCHARGER_MCP_* configures the HTTP transport).`);
    }
    extraKeys.push({ key: envKey(key), defaultName: key.toLowerCase() });
  }
  for (const { key, defaultName } of extraKeys) {
    const c = parseConnection(env, `HARDCHARGER_${key}_`, defaultName, globals);
    if (c) connections.push(c);
  }

  if (connections.length === 0) {
    throw new ConfigError(
      "HARDCHARGER_URI is required: the Hardcharger server's URI, e.g. hardcharger://db.example.com " +
        "(TLS to port 31337), or hardcharger://localhost?tls=false for a server without TLS.",
    );
  }
  const seen = new Map<string, string>();
  for (const c of connections) {
    const k = c.name.toLowerCase();
    if (seen.has(k)) {
      throw new ConfigError(`Connection name "${c.name}" is used more than once (names are case-insensitive).`);
    }
    seen.set(k, c.name);
  }

  const mcpBearerToken = nonEmpty(env.HARDCHARGER_MCP_BEARER_TOKEN);
  const mcpOAuth = parseOAuth(env);
  if (mcpBearerToken !== undefined && mcpOAuth !== undefined) {
    throw new ConfigError(
      "HARDCHARGER_MCP_BEARER_TOKEN and HARDCHARGER_MCP_OAUTH_ISSUER are mutually exclusive: pick one way to authenticate HTTP clients.",
    );
  }

  return {
    connections,
    allowWrites: parseBoolean("HARDCHARGER_ALLOW_WRITES", env.HARDCHARGER_ALLOW_WRITES, false),
    maxRows: parseInteger("HARDCHARGER_MAX_ROWS", env.HARDCHARGER_MAX_ROWS, DEFAULTS.maxRows, { min: 1, max: 100000 }),
    maxCellChars: parseInteger("HARDCHARGER_MAX_CELL_CHARS", env.HARDCHARGER_MAX_CELL_CHARS, DEFAULTS.maxCellChars, {
      min: 1,
      max: 100000,
    }),
    queryTimeoutSeconds,
    mcpBearerToken,
    mcpOAuth,
    mcpSessionIdleSeconds: parseInteger(
      "HARDCHARGER_MCP_SESSION_IDLE_SECONDS",
      env.HARDCHARGER_MCP_SESSION_IDLE_SECONDS,
      DEFAULTS.sessionIdleSeconds,
      { min: 1, max: 86400 },
    ),
    mcpMaxSessions: parseInteger("HARDCHARGER_MCP_MAX_SESSIONS", env.HARDCHARGER_MCP_MAX_SESSIONS, DEFAULTS.maxSessions, {
      min: 1,
      max: 100000,
    }),
    enableSso,
  };
}

/** Splits a comma- or whitespace-separated list, dropping blanks. */
function parseList(raw: string | undefined): string[] {
  const v = nonEmpty(raw);
  if (v === undefined) return [];
  return v
    .split(/[\s,]+/u)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function parseHttpsUrl(name: string, raw: string | undefined, { allowHttp }: { allowHttp: boolean }): string | undefined {
  const v = nonEmpty(raw);
  if (v === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL (got "${v}").`);
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new ConfigError(`${name} must use https (got "${v}").`);
  }
  if (url.hash) throw new ConfigError(`${name} must not contain a fragment (got "${v}").`);
  return v.replace(/\/+$/u, "");
}

/** Default claim precedence used to name an authenticated caller. */
export const DEFAULT_USER_CLAIMS = ["email", "preferred_username", "upn", "name", "sub"] as const;

/**
 * Reads the OAuth resource-server settings for the HTTP transport. Returns
 * undefined unless HARDCHARGER_MCP_OAUTH_ISSUER is set. Plain http URLs are
 * accepted for the issuer and public URL only when
 * HARDCHARGER_MCP_OAUTH_ALLOW_INSECURE=true (local testing).
 */
export function parseOAuth(env: NodeJS.ProcessEnv): OAuthConfig | undefined {
  const allowHttp = parseBoolean("HARDCHARGER_MCP_OAUTH_ALLOW_INSECURE", env.HARDCHARGER_MCP_OAUTH_ALLOW_INSECURE, false);
  const issuer = parseHttpsUrl("HARDCHARGER_MCP_OAUTH_ISSUER", env.HARDCHARGER_MCP_OAUTH_ISSUER, { allowHttp });
  const publicUrl = parseHttpsUrl("HARDCHARGER_MCP_PUBLIC_URL", env.HARDCHARGER_MCP_PUBLIC_URL, { allowHttp });
  if (issuer === undefined) {
    for (const key of Object.keys(env)) {
      if (key.startsWith("HARDCHARGER_MCP_OAUTH_") && key !== "HARDCHARGER_MCP_OAUTH_ALLOW_INSECURE" && !isUnset(env[key])) {
        throw new ConfigError(`${key} is set but HARDCHARGER_MCP_OAUTH_ISSUER is not; the issuer enables OAuth.`);
      }
    }
    return undefined;
  }
  if (publicUrl === undefined) {
    throw new ConfigError(
      "HARDCHARGER_MCP_PUBLIC_URL is required with HARDCHARGER_MCP_OAUTH_ISSUER: the public URL of the /mcp endpoint " +
        "(e.g. https://mcp.example.com/mcp) is the OAuth resource identifier clients request tokens for.",
    );
  }
  const jwksUri = parseHttpsUrl("HARDCHARGER_MCP_OAUTH_JWKS_URI", env.HARDCHARGER_MCP_OAUTH_JWKS_URI, { allowHttp });
  const audiences = parseList(env.HARDCHARGER_MCP_OAUTH_AUDIENCE);
  const userClaims = parseList(env.HARDCHARGER_MCP_OAUTH_USER_CLAIM);
  return {
    publicUrl,
    issuer,
    audiences: audiences.length > 0 ? audiences : [publicUrl],
    jwksUri,
    scopes: parseList(env.HARDCHARGER_MCP_OAUTH_SCOPES),
    userClaims: userClaims.length > 0 ? userClaims : [...DEFAULT_USER_CLAIMS],
    authorizedEmails: parseList(env.HARDCHARGER_MCP_OAUTH_AUTHORIZED_EMAILS),
    tokenProxy: parseBoolean("HARDCHARGER_MCP_OAUTH_TOKEN_PROXY", env.HARDCHARGER_MCP_OAUTH_TOKEN_PROXY, false),
  };
}

/** The sign-in a connection's settings call for (before any login_sso). */
export function authMethod(
  config: Pick<ConnectionConfig, "username" | "token" | "mtlsCertFile">,
): AuthMethod {
  if (config.username !== undefined) return "password";
  if (config.token !== undefined) return "token";
  if (config.mtlsCertFile !== undefined) return "mtls";
  return "none";
}

/** Replaces every configured secret in `text` with `***`. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length === 0) continue;
    out = out.split(s).join("***");
    const encoded = encodeURIComponent(s);
    if (encoded !== s) out = out.split(encoded).join("***");
  }
  return out;
}

export class QueryTimeoutError extends Error {
  constructor(seconds: number) {
    super(
      `Query exceeded the ${seconds}s timeout (HARDCHARGER_QUERY_TIMEOUT_SECONDS) and was cancelled ` +
        "(statement_timeout).",
    );
    this.name = "QueryTimeoutError";
  }
}

/** Grace added to the server-side timeout before the client-side abort fires. */
const CLIENT_DEADLINE_GRACE_MS = 5000;
/** If an abort does not settle the call, drop the connection after this. */
const HARD_RESET_GRACE_MS = 15000;

/** A capped result: up to `maxRows + 1` rows so callers can detect truncation. */
export interface CappedResult {
  table: Table;
  /** True when more rows existed beyond `maxRows` (the extra row is not in `table`). */
  truncated: boolean;
}

/** The error's Hardcharger (Chargewire) code, if it is one of the client's errors. */
export function errorCode(err: unknown): string | undefined {
  return err instanceof HardchargerError ? err.code : undefined;
}

/**
 * `session_ended` reasons after which the user's sign-in itself no longer holds (Chargewire
 * §4.2, §5.6): a revoked token, changed credentials, a dropped user. Nothing signs in again
 * on its own after these; the error is the answer.
 */
const SIGN_IN_WITHDRAWN = new Set(["token_revoked", "credentials_changed", "principal_dropped"]);

/**
 * Does this error mean the connection (or the server's session behind it) is gone in a
 * way that a fresh connection with the same credentials cures? The client itself already
 * replaces a session the server lost (`session_not_found`, an expired token) and replays
 * the session's options; this covers what it can't: a session an administrator ended
 * (`session_ended` with reason `killed`, e.g. `KILL SESSION`, an expired token, or a reason
 * this server doesn't know), a closed connection, a transport failure, and a lost session
 * the client could not replace. A refused credential is never retried, and neither is a
 * session ended because the sign-in was withdrawn (`token_revoked`, `credentials_changed`,
 * `principal_dropped`).
 */
export function isConnectionLost(err: unknown): boolean {
  const code = errorCode(err);
  if (code === HardchargerErrorCode.sessionEnded) return !SIGN_IN_WITHDRAWN.has(String((err as HardchargerError).reason ?? ""));
  return (
    code === HardchargerErrorCode.sessionNotFound ||
    code === HardchargerErrorCode.clientConnectionClosed ||
    code === HardchargerErrorCode.clientTransportError
  );
}

/** A plain-HTTP server answered a TLS handshake: the URI needs `?tls=false`. */
function isPlainHttpServer(err: unknown): boolean {
  if (errorCode(err) !== HardchargerErrorCode.clientTransportError) return false;
  const text = `${err instanceof Error ? err.message : ""} ${String((err as { cause?: unknown }).cause ?? "")}`;
  return /wrong version number|ERR_SSL_WRONG_VERSION_NUMBER|packet length too long/iu.test(text);
}

export interface SessionOverrides {
  /**
   * Replaces the configured credentials with the Hardcharger access token a browser sign-in
   * (login_sso) handed out; kept in memory only and used as is, never renewed.
   */
  accessToken?: string;
}

/** The session's catalog and schema, kept by the client and replayed on a replacement session. */
export interface SearchPath {
  catalog?: string;
  schema?: string;
}

export interface RunOptions {
  /** Overrides the configured timeout for this operation (seconds; 0 = none). */
  timeoutSeconds?: number;
}

/** What `run` hands each operation: the connection and the statement options to use. */
export interface RunContext {
  signal: AbortSignal | undefined;
  /** The server-side timeout (§6.9) for statements, when one applies. */
  statementTimeoutMs: number | undefined;
}

/** Setting names read from hardcharger_settings() and reported by server_info. */
export const SERVER_SETTINGS_OF_INTEREST = [
  "hardcharger.version",
  "hardcharger.read_only",
  "hardcharger.max_sessions",
  "hardcharger.session_idle_timeout",
  "hardcharger.query_timeout",
  "hardcharger.memory_limit",
  "hardcharger.max_concurrent_statements",
  "hardcharger.instance_id",
  "hardcharger.cluster_id",
] as const;

export interface ConnectionHooks {
  /** Test hook: opens the client connection (defaults to `connect` from @gizmodata/hardcharger). */
  connect?: (options: ConnectOptions) => Promise<Connection>;
}

function readPem(what: string, file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read the ${what} file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * One Hardcharger connection per configured server, opened lazily and serialized so a
 * single statement is in flight at a time. Timeouts are enforced by the server
 * (`statementTimeoutMs`, Chargewire §6.9) with a client-side abort as backstop that cancels
 * the statement on the server; only if that fails to settle the call is the connection
 * dropped and reopened. The client replaces a session the server lost and replays its
 * catalog and schema; a connection that is gone altogether (a killed session, a closed
 * connection, a transport failure) is reopened once and the operation retried.
 */
export class HardchargerConnection {
  private client: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private overrides: SessionOverrides = {};
  private warnings: string[] = [];
  private searchPath: SearchPath;
  /** Wall-clock at which the current client was opened (for server_info). */
  connectedAt: Date | null = null;
  /** Sessions the server lost and the client replaced, over every client this connection opened. */
  private replacedBefore = 0;
  /** Times a lost connection was reopened by this layer (a killed session, a transport failure). */
  reconnects = 0;
  /** The server's startup settings from hardcharger_settings(); null until read or when unavailable. */
  private serverSettings: Map<string, string> | null = null;
  private readonly openClient: NonNullable<ConnectionHooks["connect"]>;

  constructor(
    readonly config: ConnectionConfig,
    private readonly log: (message: string) => void = (m) => console.error(m),
    hooks: ConnectionHooks = {},
  ) {
    this.searchPath = { catalog: config.defaultCatalog, schema: config.defaultSchema };
    this.openClient = hooks.connect ?? hardchargerConnect;
  }

  /** The search path (catalog, schema) applied to every session. */
  currentSearchPath(): SearchPath {
    return { ...this.searchPath };
  }

  /**
   * Switches the session's default catalog and/or schema (Chargewire session options, which
   * the client replays on a replacement session). Throws when the server refuses it.
   */
  async useSchema(path: SearchPath): Promise<SearchPath> {
    if (!path.catalog && !path.schema) throw new Error("use_schema needs a catalog and/or schema name.");
    return this.run(async (c) => {
      const options: Record<string, unknown> = {};
      if (path.catalog) options.catalog = path.catalog;
      if (path.schema) options.schema = path.schema;
      await c.setOptions(options);
      return this.pinSearchPath(c);
    });
  }

  /**
   * Re-reads the session's catalog and schema (after a `USE`, which the server applies but
   * the client does not replay) and sets both as session options, so a replacement session
   * gets the same search path.
   */
  async syncSearchPath(): Promise<SearchPath> {
    return this.run((c) => this.pinSearchPath(c));
  }

  private async pinSearchPath(c: Connection): Promise<SearchPath> {
    const doc = await c.getSession();
    const catalog = typeof doc.options?.catalog === "string" ? doc.options.catalog : undefined;
    const schema = typeof doc.options?.schema === "string" ? doc.options.schema : undefined;
    if (catalog !== undefined && schema !== undefined) await c.setOptions({ catalog, schema });
    this.searchPath = { catalog, schema };
    return { ...this.searchPath };
  }

  /** Secrets to redact from any message that might reach a client. */
  secrets(): Array<string | undefined> {
    return [this.config.password, this.config.token, this.overrides.accessToken];
  }

  redact(text: string): string {
    return redactSecrets(text, this.secrets());
  }

  /** Effective auth method, taking login_sso into account. */
  effectiveAuth(): { method: AuthMethod; user?: string } {
    if (this.overrides.accessToken !== undefined) return { method: "sso" };
    const method = authMethod(this.config);
    return { method, user: method === "password" ? this.config.username : undefined };
  }

  /** Session-setup warnings (e.g. a default catalog the server does not have). */
  sessionWarnings(): string[] {
    return [...this.warnings];
  }

  /** Sessions the server lost and the client replaced (over this connection's lifetime). */
  sessionReplacements(): number {
    return this.replacedBefore + (this.client?.sessionReplacements ?? 0);
  }

  /** The server's idle timeout for this connection's session, as the session document announced it. */
  async sessionIdleTimeoutSeconds(): Promise<number | null> {
    try {
      const doc = await this.run((c) => c.getSession());
      return typeof doc.idle_timeout_s === "number" ? doc.idle_timeout_s : null;
    } catch {
      return null;
    }
  }

  /** The server's discovery document (name, version, capabilities, grants), once connected. */
  discovery(): Connection["server"] | null {
    return this.client?.server ?? null;
  }

  /** Swaps in new credentials (login_sso) and drops the current connection. */
  async useCredentials(overrides: SessionOverrides): Promise<void> {
    this.overrides = overrides;
    await this.reset();
  }

  /** Where a browser sign-in (login_sso) runs: the connection's own URI, with its TLS settings. */
  signInTarget(): BrowserSignInTarget {
    const target: BrowserSignInTarget = { url: this.config.uri };
    const tls = this.tlsOptions();
    if (tls !== undefined) target.tls = tls;
    return target;
  }

  /** The TLS settings (roots, client certificate, skip verify) for this connection, if any. */
  private tlsOptions(): ConnectOptions["tls"] {
    const cfg = this.config;
    if (!cfg.tls) return undefined;
    const tls: NonNullable<ConnectOptions["tls"]> = {};
    if (cfg.tlsRootsFile) tls.ca = readPem("TLS roots", cfg.tlsRootsFile);
    if (cfg.mtlsCertFile && cfg.mtlsKeyFile) {
      tls.cert = readPem("client certificate", cfg.mtlsCertFile);
      tls.key = readPem("client key", cfg.mtlsKeyFile);
    }
    if (cfg.tlsSkipVerify) tls.skipVerify = true;
    return Object.keys(tls).length > 0 ? tls : undefined;
  }

  /** The client's connect options for this connection's settings. */
  clientOptions(): ConnectOptions {
    const cfg = this.config;
    const options: ConnectOptions = {
      url: cfg.uri,
      logger: {
        warn: (message, fields) =>
          this.log(`[hardcharger-mcp] ${this.redact(message)}${fields ? ` ${this.redact(JSON.stringify(fields))}` : ""}`),
      },
    };
    const tls = this.tlsOptions();
    if (tls !== undefined) options.tls = tls;
    if (this.overrides.accessToken !== undefined) {
      options.token = this.overrides.accessToken;
    } else if (cfg.username !== undefined) {
      options.username = cfg.username;
      options.password = cfg.password ?? "";
    } else if (cfg.token !== undefined) {
      options.subjectToken = cfg.token;
    } else if (cfg.mtlsCertFile !== undefined) {
      options.authType = "mtls";
    }
    return options;
  }

  /** Opens a fresh client and applies the session settings. */
  private async open(): Promise<Connection> {
    if (this.overrides.accessToken === undefined && authMethod(this.config) === "none") {
      throw new Error(
        `Connection "${this.config.name}" has no credentials yet: call login_sso to sign in through the ` +
          "server's identity provider in your browser.",
      );
    }
    let client: Connection;
    try {
      client = await this.openClient(this.clientOptions());
    } catch (err) {
      if (isPlainHttpServer(err)) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}\nThe server at ${this.config.host}:${this.config.port} ` +
            "speaks plain HTTP, not TLS: add ?tls=false to the connection URI (hardcharger://host:port?tls=false).",
          { cause: err },
        );
      }
      throw err;
    }
    await this.applySessionSettings(client);
    await this.probeServerSettings(client);
    this.connectedAt = new Date();
    return client;
  }

  /**
   * The search path, as Chargewire session options. A catalog or schema the server does not
   * have is reported (with the catalogs it does have) instead of failing the connection;
   * the server's default then applies.
   */
  private async applySessionSettings(client: Connection): Promise<void> {
    this.warnings = [];
    const options: Record<string, unknown> = {};
    if (this.searchPath.catalog) options.catalog = this.searchPath.catalog;
    if (this.searchPath.schema) options.schema = this.searchPath.schema;
    if (Object.keys(options).length === 0) return;
    try {
      await client.setOptions(options);
    } catch (err) {
      const msg = this.redact(err instanceof Error ? err.message : String(err));
      let available = "";
      try {
        const catalogs = await client.metadata.catalogs();
        const names: string[] = [];
        for (let i = 0; i < catalogs.numRows; i++) names.push(String(catalogs.getChild("catalog_name")?.get(i)));
        available = ` Available catalogs: ${names.join(", ")}.`;
      } catch {
        // best effort
      }
      const wanted = [this.searchPath.catalog, this.searchPath.schema].filter(Boolean).join(".");
      this.warnings.push(
        `Default catalog/schema could not be applied (${wanted}); the server's own default is in effect.${available} ${msg}`,
      );
      this.log(`[hardcharger-mcp] warning: ${this.warnings[this.warnings.length - 1]}`);
    }
  }

  /** Reads the server's startup settings once per connection; never fails the connection. */
  private async probeServerSettings(client: Connection): Promise<void> {
    const names = SERVER_SETTINGS_OF_INTEREST.map((n) => `'${n}'`).join(", ");
    try {
      const table = await client.query(`SELECT name, value FROM hardcharger_settings() WHERE name IN (${names})`);
      const found = new Map<string, string>();
      const nameCol = table.getChild("name");
      const valueCol = table.getChild("value");
      if (nameCol && valueCol) {
        for (let i = 0; i < table.numRows; i++) {
          const n = nameCol.get(i);
          const v = valueCol.get(i);
          if (typeof n === "string" && v !== null && v !== undefined) found.set(n, String(v));
        }
      }
      this.serverSettings = found;
    } catch (err) {
      this.serverSettings = null;
      this.log(`[hardcharger-mcp] server settings unavailable: ${this.redact(err instanceof Error ? err.message : String(err))}`);
    }
  }

  /** The server's reported startup settings (name -> value); empty when unknown. */
  serverSettingsSnapshot(): Record<string, string> {
    return Object.fromEntries(this.serverSettings ?? []);
  }

  /** Returns the shared client, opening it on first use. */
  async get(): Promise<Connection> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = this.open()
        .then((c) => {
          this.client = c;
          return c;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  /** Closes the current client (ending its session on the server). */
  async reset(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connectedAt = null;
    if (client) {
      this.replacedBefore += client.sessionReplacements;
      try {
        await client.close();
      } catch {
        // already gone
      }
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }

  /**
   * Runs `fn` against the shared client with: serialization, one retry after the
   * connection was lost (see isConnectionLost), and a deadline: the server's statement
   * timeout, a client-side abort a few seconds later that cancels the statement on the
   * server, and as a last resort dropping the connection.
   */
  async run<T>(fn: (client: Connection, ctx: RunContext) => Promise<T>, options: RunOptions = {}): Promise<T> {
    const task = async (): Promise<T> => {
      let attempt = 0;
      for (;;) {
        attempt++;
        const client = await this.get();
        try {
          return await this.withDeadline((ctx) => fn(client, ctx), options.timeoutSeconds);
        } catch (err) {
          if (err instanceof QueryTimeoutError) throw err;
          if (attempt < 2 && isConnectionLost(err)) {
            this.log(
              `[hardcharger-mcp] connection lost (${errorCode(err)}), reconnecting: ${this.redact(err instanceof Error ? err.message : String(err))}`,
            );
            this.reconnects++;
            await this.reset();
            continue;
          }
          throw err;
        }
      }
    };
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async withDeadline<T>(fn: (ctx: RunContext) => Promise<T>, timeoutSeconds?: number): Promise<T> {
    const seconds = timeoutSeconds ?? this.config.queryTimeoutSeconds;
    if (!seconds || seconds <= 0) return fn({ signal: undefined, statementTimeoutMs: undefined });
    // The server cancels the statement at `seconds` (statementTimeoutMs); the client-side
    // abort is a backstop a few seconds later.
    const controller = new AbortController();
    const timeoutError = new QueryTimeoutError(seconds);
    let abortTimer: NodeJS.Timeout | undefined;
    let resetTimer: NodeJS.Timeout | undefined;
    const hardReset = new Promise<never>((_, reject) => {
      abortTimer = setTimeout(() => {
        controller.abort(timeoutError);
        // If the abort cannot settle the call, drop the connection.
        resetTimer = setTimeout(() => {
          void this.reset().finally(() => reject(timeoutError));
        }, HARD_RESET_GRACE_MS);
      }, seconds * 1000 + CLIENT_DEADLINE_GRACE_MS);
    });
    try {
      return await Promise.race([fn({ signal: controller.signal, statementTimeoutMs: seconds * 1000 }), hardReset]);
    } catch (err) {
      const code = errorCode(err);
      if (code === "statement_timeout" || err === timeoutError || (controller.signal.aborted && code === "statement_cancelled")) {
        throw timeoutError;
      }
      throw err;
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      if (resetTimer) clearTimeout(resetTimer);
    }
  }

  /** Convenience: execute a query returning an Arrow table. */
  query(sql: string, params?: BoundParams, options?: RunOptions): Promise<Table> {
    return this.run(async (c, ctx) => {
      if (params instanceof Table) {
        const prepared = await c.prepare(sql, { signal: ctx.signal });
        try {
          return await prepared.query(params, statementOptions(ctx));
        } finally {
          await prepared.close().catch(() => undefined);
        }
      }
      return c.query(sql, params, statementOptions(ctx));
    }, options);
  }

  /**
   * Executes a query and reads at most `maxRows + 1` rows from one result stream, then
   * closes the stream, which stops the statement on the server: no further batches are
   * transferred or computed.
   */
  queryCapped(sql: string, params: BoundParams | undefined, maxRows: number, options?: RunOptions): Promise<CappedResult> {
    return this.run(async (c, ctx) => {
      // One partition: a capped result is small, and one stream stops cleanly at the cap.
      const callOptions = { ...statementOptions(ctx), resultPartitions: 1 };
      let prepared: Awaited<ReturnType<Connection["prepare"]>> | undefined;
      try {
        let stream;
        if (params instanceof Table) {
          prepared = await c.prepare(sql, { signal: ctx.signal });
          stream = prepared.stream(params, callOptions);
        } else {
          stream = c.stream(sql, params, callOptions);
        }
        const batches: RecordBatch[] = [];
        let rows = 0;
        try {
          for await (const batch of stream) {
            batches.push(batch);
            rows += batch.numRows;
            if (rows > maxRows) break; // closes the stream
          }
        } finally {
          await stream.close().catch(() => undefined);
        }
        const table = batches.length > 0 ? new Table(batches) : new Table(await stream.schema());
        return { table: rows > maxRows ? table.slice(0, maxRows) : table, truncated: rows > maxRows };
      } finally {
        await prepared?.close().catch(() => undefined);
      }
    }, options);
  }

  /** Convenience: execute a statement returning the affected-row count (-1 when the engine does not count). */
  update(sql: string, params?: BoundParams, options?: RunOptions): Promise<number> {
    return this.run(async (c, ctx) => {
      let count: number | null;
      if (params instanceof Table) {
        const prepared = await c.prepare(sql, { signal: ctx.signal });
        try {
          count = await prepared.execute(params, statementOptions(ctx));
        } finally {
          await prepared.close().catch(() => undefined);
        }
      } else {
        count = await c.execute(sql, params, statementOptions(ctx));
      }
      return count ?? -1;
    }, options);
  }
}

function statementOptions(ctx: RunContext): { signal?: AbortSignal; statementTimeoutMs?: number } {
  const out: { signal?: AbortSignal; statementTimeoutMs?: number } = {};
  if (ctx.signal) out.signal = ctx.signal;
  if (ctx.statementTimeoutMs !== undefined) out.statementTimeoutMs = ctx.statementTimeoutMs;
  return out;
}
