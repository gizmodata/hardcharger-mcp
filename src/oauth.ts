// OAuth 2.1 resource-server support for the Streamable HTTP transport.
//
// The MCP server never issues tokens itself. An OpenID Connect provider
// (Microsoft Entra ID, Okta, Auth0, Keycloak, Cognito, Clerk, ...) is the
// authorization server; this module
//   - discovers the provider's JWKS from its issuer URL,
//   - verifies the bearer token on every request (signature, issuer,
//     audience, expiry) and derives the caller's identity from its claims,
//   - optionally restricts callers to an email allowlist, and
//   - renders the RFC 9728 protected-resource metadata and the
//     WWW-Authenticate challenge that let MCP clients such as Claude.ai
//     find the authorization server on their own.
//
// The Hardcharger connection itself keeps using the configured service
// credentials: the caller's token is validated here and never forwarded.

import { createHash } from "node:crypto";

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export interface OAuthConfig {
  /** Canonical public URL of the MCP endpoint, e.g. https://mcp.example.com/mcp. */
  publicUrl: string;
  /** Issuer URL of the OpenID Connect provider (the `iss` claim). */
  issuer: string;
  /** Accepted `aud` values; a token must carry at least one of them. */
  audiences: string[];
  /** JWKS endpoint; discovered from the issuer when unset. */
  jwksUri?: string;
  /** Scopes advertised to clients (`scopes_supported`) and requested on a 401. */
  scopes: string[];
  /** Claims tried in order to name the caller (first non-empty string wins). */
  userClaims: string[];
  /** Glob patterns (`*@example.com`, `alice@example.com`); empty = everyone the provider signs in. */
  authorizedEmails: string[];
  /**
   * Publish an authorization-server facade and proxy the token endpoint so
   * refresh_token grants carry the API scope (needed for Microsoft Entra ID).
   */
  tokenProxy?: boolean;
}

/** Identity derived from a verified access token. */
export interface AuthenticatedUser {
  /** The `sub` claim. */
  subject: string;
  /** Display name: the first configured user claim that is present. */
  name: string;
  /** Email-like address if any of `email`, `preferred_username` or `upn` looks like one. */
  email?: string;
  claims: JWTPayload;
}

export type AuthFailureCode = "invalid_token" | "forbidden";

export class OAuthError extends Error {
  constructor(
    readonly code: AuthFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
  /** HTTP status the transport should answer with. */
  get status(): 401 | 403 {
    return this.code === "forbidden" ? 403 : 401;
  }
}

/** Asymmetric algorithms only: a symmetric alg would let the JWKS-hosted public key act as a secret. */
export const ALLOWED_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

/**
 * OpenID Connect scope that asks the provider for a refresh token. Claude
 * requests exactly the scopes named in the WWW-Authenticate challenge, so it
 * must be advertised here or the client cannot outlive the access token.
 */
export const OFFLINE_ACCESS_SCOPE = "offline_access";

/** Tolerated clock skew between the provider and this host, in seconds. */
export const CLOCK_TOLERANCE_SECONDS = 60;

/** Well-known path of the protected-resource metadata, without and with the endpoint path (RFC 9728 §3.1). */
export function protectedResourceMetadataPaths(publicUrl: string): string[] {
  const path = new URL(publicUrl).pathname.replace(/\/+$/u, "");
  const base = "/.well-known/oauth-protected-resource";
  return path && path !== "/" ? [base, `${base}${path}`] : [base];
}

/** URL of the protected-resource metadata document (the path-suffixed form, which clients try first). */
export function protectedResourceMetadataUrl(publicUrl: string): string {
  const u = new URL(publicUrl);
  const paths = protectedResourceMetadataPaths(publicUrl);
  return `${u.origin}${paths[paths.length - 1]}`;
}

/** Candidate discovery documents for an issuer: OpenID Connect first, then RFC 8414 (both path placements). */
export function discoveryUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/u, "");
  const urls = [`${u.origin}${path}/.well-known/openid-configuration`];
  if (path) {
    urls.push(`${u.origin}/.well-known/oauth-authorization-server${path}`);
    urls.push(`${u.origin}${path}/.well-known/oauth-authorization-server`);
  } else {
    urls.push(`${u.origin}/.well-known/oauth-authorization-server`);
  }
  return urls;
}

/** Case-insensitive glob match where `*` matches any run of characters. */
export function emailMatches(email: string, pattern: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .trim()
        .toLowerCase()
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*") +
      "$",
    "u",
  );
  return re.test(email.trim().toLowerCase());
}

const EMAIL_CLAIMS = ["email", "preferred_username", "upn"];

function firstString(claims: JWTPayload, names: string[]): string | undefined {
  for (const n of names) {
    const v = claims[n];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/** Builds the identity for a verified token payload. */
export function userFromClaims(claims: JWTPayload, userClaims: string[]): AuthenticatedUser {
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  const emailish = EMAIL_CLAIMS.map((n) => claims[n]).find((v) => typeof v === "string" && v.includes("@")) as
    | string
    | undefined;
  return {
    subject,
    name: firstString(claims, userClaims) ?? subject ?? "unknown",
    email: emailish?.trim(),
    claims,
  };
}

/** What an introspection says about a token (RFC 7662 style): who it belongs to, if it is active. */
export interface IntrospectionResult {
  active: boolean;
  sub?: string;
  email?: string;
  name?: string;
}

/** How long a positive introspection is reused for the same token. */
export const INTROSPECTION_CACHE_MS = 60_000;
const INTROSPECTION_CACHE_MAX = 10_000;

export interface VerifierOptions {
  /** Test hook: replaces global fetch for discovery. */
  fetch?: typeof fetch;
  /** Test hook: replaces the remote JWKS key resolver. */
  getKey?: JWTVerifyGetKey;
  log?: (message: string) => void;
  /**
   * Asks someone else whether a token is active instead of verifying it as a JWT (a connection
   * broker, for providers whose access tokens are opaque). Errors other than "inactive" propagate.
   */
  introspect?: (token: string) => Promise<IntrospectionResult>;
  /** Test hook: clock (ms). */
  now?: () => number;
}

/** Verifies bearer tokens against one OpenID Connect provider. */
export class OAuthVerifier {
  private keyResolver: JWTVerifyGetKey | undefined;
  private discovering: Promise<JWTVerifyGetKey> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;
  private readonly introspect: VerifierOptions["introspect"];
  private readonly now: () => number;
  /** Positive introspections by token hash, with when they stop being reused. */
  private readonly introspected = new Map<string, { claims: JWTPayload; until: number }>();

  constructor(
    readonly config: OAuthConfig,
    options: VerifierOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.log = options.log ?? ((m) => console.error(m));
    if (options.getKey) this.keyResolver = options.getKey;
    this.introspect = options.introspect;
    this.now = options.now ?? (() => Date.now());
  }

  /** True when tokens are checked by introspection rather than as JWTs. */
  get introspects(): boolean {
    return this.introspect !== undefined;
  }

  /** RFC 9728 protected-resource metadata document; `authorizationServer` overrides the issuer (token-proxy facade). */
  protectedResourceMetadata(authorizationServer: string = this.config.issuer): Record<string, unknown> {
    const doc: Record<string, unknown> = {
      resource: this.config.publicUrl,
      authorization_servers: [authorizationServer],
      bearer_methods_supported: ["header"],
    };
    if (this.config.scopes.length > 0) doc.scopes_supported = this.config.scopes;
    return doc;
  }

  /** `WWW-Authenticate` value for a 401 (RFC 6750 §3 + RFC 9728 §5.1). */
  challenge(error?: AuthFailureCode, description?: string): string {
    const parts: string[] = [];
    if (error) parts.push(`error="${error}"`);
    if (description) parts.push(`error_description="${description.replace(/["\\\r\n]/gu, " ")}"`);
    parts.push(`resource_metadata="${protectedResourceMetadataUrl(this.config.publicUrl)}"`);
    if (this.config.scopes.length > 0) parts.push(`scope="${this.config.scopes.join(" ")}"`);
    return `Bearer ${parts.join(", ")}`;
  }

  /**
   * Validates a bearer token and returns the caller. Throws OAuthError with
   * code `invalid_token` (401) for a missing, malformed, expired or
   * mis-issued token and `forbidden` (403) when the caller is not on the
   * email allowlist.
   */
  async verify(authorization: string | undefined): Promise<AuthenticatedUser> {
    const m = authorization ? /^Bearer\s+(.+)$/iu.exec(authorization.trim()) : null;
    if (!m) throw new OAuthError("invalid_token", "Bearer token required");
    const token = m[1].trim();

    let claims: JWTPayload;
    if (this.introspect) {
      claims = await this.introspectToken(token);
    } else {
      const getKey = await this.resolveKeys();
      try {
        const result = await jwtVerify(token, getKey, {
          issuer: this.config.issuer,
          audience: this.config.audiences,
          algorithms: ALLOWED_ALGORITHMS,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        });
        claims = result.payload;
      } catch (err) {
        throw new OAuthError("invalid_token", err instanceof Error ? err.message : String(err));
      }
    }

    const user = userFromClaims(claims, this.config.userClaims);
    if (this.config.authorizedEmails.length > 0) {
      const email = user.email;
      const allowed = email !== undefined && this.config.authorizedEmails.some((p) => emailMatches(email, p));
      if (!allowed) {
        throw new OAuthError("forbidden", `${email ?? user.name} is not authorized to use this server`);
      }
    }
    return user;
  }

  /**
   * Claims for an introspected token: reused for INTROSPECTION_CACHE_MS when active, so a burst of
   * MCP requests costs one introspection. An inactive token is never cached.
   */
  private async introspectToken(token: string): Promise<JWTPayload> {
    const key = createHash("sha256").update(token).digest("hex");
    const now = this.now();
    const cached = this.introspected.get(key);
    if (cached && now < cached.until) return cached.claims;
    const result = await this.introspect!(token);
    if (!result.active || !result.sub) {
      this.introspected.delete(key);
      throw new OAuthError("invalid_token", "The token is not active");
    }
    const claims: JWTPayload = { sub: result.sub };
    if (result.email) claims.email = result.email;
    if (result.name) claims.name = result.name;
    if (this.introspected.size >= INTROSPECTION_CACHE_MAX) {
      for (const [k, v] of this.introspected) if (v.until <= now) this.introspected.delete(k);
      if (this.introspected.size >= INTROSPECTION_CACHE_MAX) this.introspected.delete(this.introspected.keys().next().value!);
    }
    this.introspected.set(key, { claims, until: now + INTROSPECTION_CACHE_MS });
    return claims;
  }

  private resolveKeys(): Promise<JWTVerifyGetKey> {
    if (this.keyResolver) return Promise.resolve(this.keyResolver);
    if (!this.discovering) {
      this.discovering = this.discoverJwks()
        .then((uri) => {
          this.keyResolver = createRemoteJWKSet(new URL(uri));
          this.log(`[hardcharger-mcp] OAuth: verifying tokens from ${this.config.issuer} with keys at ${uri}`);
          return this.keyResolver;
        })
        .finally(() => {
          this.discovering = undefined;
        });
    }
    return this.discovering;
  }

  /** Returns the JWKS URI: configured, or read from the provider's discovery document. */
  private async discoverJwks(): Promise<string> {
    if (this.config.jwksUri) return this.config.jwksUri;
    try {
      const doc = await discoverMetadata(this.config.issuer, this.fetchImpl);
      return doc.jwks_uri as string;
    } catch (err) {
      throw new OAuthError(
        "invalid_token",
        `${err instanceof Error ? err.message : String(err)}; set HARDCHARGER_MCP_OAUTH_JWKS_URI to skip discovery`,
      );
    }
  }
}

/**
 * Fetches the provider's discovery document (OpenID Connect first, then RFC
 * 8414). The document must name the configured issuer and a jwks_uri.
 */
export async function discoverMetadata(issuer: string, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  for (const url of discoveryUrls(issuer)) {
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      const doc = (await res.json()) as Record<string, unknown>;
      if (typeof doc.jwks_uri !== "string" || doc.jwks_uri === "") {
        errors.push(`${url}: no jwks_uri`);
        continue;
      }
      if (typeof doc.issuer === "string" && doc.issuer.replace(/\/+$/u, "") !== issuer.replace(/\/+$/u, "")) {
        errors.push(`${url}: issuer ${doc.issuer} does not match ${issuer}`);
        continue;
      }
      return doc;
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`OAuth discovery failed for ${issuer} (${errors.join("; ")})`);
}
