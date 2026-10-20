// A throwaway OpenID Connect provider for tests: discovery document, JWKS, a signer, and
// an authorization-code flow (an /authorize that signs in `nextLogin` at once and redirects
// back, and a token endpoint that answers the code with an ID token), on an ephemeral
// localhost port.

import * as http from "node:http";

import { SignJWT, exportJWK, generateKeyPair } from "jose";

export interface TokenOptions {
  audience?: string | string[];
  issuer?: string;
  expiresIn?: string;
}

/** A throwaway OpenID Connect provider: discovery document + JWKS + a signer. */
export class FakeIssuer {
  private server!: http.Server;
  issuer = "";
  jwksUri = "";
  discoveryHits = 0;
  /** Token requests seen by the fake token endpoint (form fields + Authorization header), oldest first. */
  tokenRequests: Array<{ params: URLSearchParams; authorization?: string }> = [];
  /** Who /authorize signs in (the ID token's claims), as if the user had logged in. */
  nextLogin: Record<string, unknown> = { sub: "sso-user", email: "sso-user@example.com" };
  /** Codes /authorize handed out: code -> client_id and claims. */
  private codes = new Map<string, { clientId: string; claims: Record<string, unknown> }>();
  private privateKey!: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  private jwks!: object;

  async start(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    this.privateKey = privateKey;
    const jwk = await exportJWK(publicKey);
    this.jwks = { keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] };
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/tenant/authorize" && req.method === "GET") {
        // Signs `nextLogin` in at once: no login page.
        const redirect = url.searchParams.get("redirect_uri");
        const clientId = url.searchParams.get("client_id") ?? "";
        if (!redirect) {
          res.writeHead(400);
          res.end("missing redirect_uri");
          return;
        }
        const code = `code-${this.codes.size + 1}`;
        this.codes.set(code, { clientId, claims: { ...this.nextLogin } });
        const back = new URL(redirect);
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        res.writeHead(302, { location: back.toString() });
        res.end();
        return;
      }
      if (req.url === "/tenant/.well-known/openid-configuration") {
        this.discoveryHits += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: this.issuer,
            jwks_uri: this.jwksUri,
            authorization_endpoint: `${this.issuer}/authorize`,
            token_endpoint: `${this.issuer}/token`,
            scopes_supported: ["openid", "offline_access"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
        return;
      }
      if (req.url === "/tenant/token" && req.method === "POST") {
        // Mimics Microsoft Entra ID: a refresh_token grant whose scope names
        // no resource is refused with AADSTS90009.
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          this.tokenRequests.push({ params, authorization: req.headers.authorization });
          const grant = params.get("grant_type");
          const scopes = (params.get("scope") ?? "").split(/\s+/u).filter((x) => x !== "");
          const oidc = new Set(["openid", "profile", "email", "offline_access"]);
          if (grant === "refresh_token" && !scopes.some((x) => !oidc.has(x))) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: "invalid_request",
                error_description:
                  "AADSTS90009: Application 'client-id-guid'(client-id-guid) is requesting a token for itself. " +
                  "This scenario is supported only if resource is specified using the GUID based App Identifier.\r\nTrace ID: t",
              }),
            );
            return;
          }
          if (grant !== "refresh_token" && grant !== "authorization_code") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unsupported_grant_type" }));
            return;
          }
          const login = grant === "authorization_code" ? this.codes.get(params.get("code") ?? "") : undefined;
          if (grant === "authorization_code" && login !== undefined) {
            // A code from /authorize: answer with an ID token for that client.
            this.codes.delete(params.get("code") ?? "");
            void this.token(login.claims, { audience: login.clientId }).then((idToken) => {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ token_type: "Bearer", access_token: "fake-access", id_token: idToken, expires_in: 3599 }));
            });
            return;
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              token_type: "Bearer",
              scope: scopes.join(" "),
              expires_in: 3599,
              access_token: `fake-access-${grant}-${this.tokenRequests.length}`,
              refresh_token: scopes.includes("offline_access") || grant === "authorization_code" ? "fake-refresh-secret" : undefined,
            }),
          );
        });
        return;
      }
      if (req.url === "/tenant/keys") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(this.jwks));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address() as { port: number };
    this.issuer = `http://127.0.0.1:${addr.port}/tenant`;
    this.jwksUri = `${this.issuer}/keys`;
  }

  async token(claims: Record<string, unknown>, opts: TokenOptions = {}): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.issuer ?? this.issuer)
      .setAudience(opts.audience ?? "api://hardcharger-mcp")
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? "5m")
      .sign(this.privateKey);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
