// Connection broker: per-user connections and sign-in tokens for the hosted HTTP transport.
//
// With HARDCHARGER_MCP_BROKER_URL, this server holds no Hardcharger credentials of its own. A
// broker (a control plane such as GizmoData Cloud) knows which Hardcharger servers each person
// may reach and mints short-lived sign-in tokens for them; the client exchanges such a token
// (Chargewire token_exchange), so every statement runs as the person who asked, under that
// person's grants. The protocol is in docs/connection-broker.md.
//
// The caller's OAuth access token is never forwarded as a credential (MCP forbids token
// passthrough). Each broker request authenticates this server with its own credential and
// presents the caller's token as an RFC 8693 subject token, which the broker verifies and
// maps to a person. Only the broker decides what that person may reach.

import { z } from "zod";

import {
  type BrokerConfig,
  type ConnectionConfig,
  type McpConfig,
  type TokenSource,
  parseHardchargerUri,
} from "./connection.js";
import { ConnectionRegistry } from "./registry.js";

/** RFC 8693 token type of the caller's OAuth access token. */
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** A minted token is reused until this share of its lifetime has passed. */
const TOKEN_REUSE_FRACTION = 0.8;

/** Connection names the tools accept (the same rule as configured connections). */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const connectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  label: z.string().nullish(),
  uri: z.string().min(1),
  default_catalog: z.string().nullish(),
  default_schema: z.string().nullish(),
  allow_writes: z.boolean().default(false),
});

const listSchema = z.object({
  connections: z.array(z.unknown()),
  /** Shown to the caller when the list is empty (e.g. how to create a server). */
  message: z.string().nullish(),
});

const tokenSchema = z.object({
  token: z.string().min(1),
  expires_in: z.number().positive(),
});

export type BrokeredConnection = z.infer<typeof connectionSchema>;

/** A broker request that failed; `message` is safe to show the caller. */
export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export interface BrokerHooks {
  /** Test hook: the fetch implementation. */
  fetch?: typeof fetch;
  /** Test hook: clock (ms). */
  now?: () => number;
}

/** The broker's error text from a JSON body (`error_description`, `message` or a string `detail`). */
function brokerDetail(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  for (const key of ["error_description", "message", "detail"]) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** Talks to the broker's two endpoints. Stateless; one instance serves every caller. */
export class BrokerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly config: BrokerConfig,
    hooks: BrokerHooks = {},
  ) {
    this.fetchImpl = hooks.fetch ?? fetch;
  }

  /** The servers the caller may reach. */
  async listConnections(subjectToken: string): Promise<{ connections: unknown[]; message?: string }> {
    const body = listSchema.safeParse(await this.post("/connections", subjectToken));
    if (!body.success) throw new BrokerError("The connection broker answered the connection list with an unexpected body.");
    return { connections: body.data.connections, message: body.data.message ?? undefined };
  }

  /** A sign-in token for the caller on one server, and its lifetime in seconds. */
  async issueToken(subjectToken: string, connectionId: string): Promise<{ token: string; expiresIn: number }> {
    const body = tokenSchema.safeParse(
      await this.post(`/connections/${encodeURIComponent(connectionId)}/token`, subjectToken),
    );
    if (!body.success) throw new BrokerError("The connection broker answered the token request with an unexpected body.");
    return { token: body.data.token, expiresIn: body.data.expires_in };
  }

  private async post(path: string, subjectToken: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.url}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.credential}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ subject_token: subjectToken, subject_token_type: ACCESS_TOKEN_TYPE }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? `no answer within ${this.config.timeoutMs} ms` : "unreachable";
      throw new BrokerError(`The connection broker is ${reason}; try again shortly.`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (res.ok) return body;
    const detail = brokerDetail(body);
    if (res.status === 401) {
      // The broker refused this server's own credential (or found the caller's token invalid).
      throw new BrokerError(
        detail ?? "The connection broker refused this request; reconnect the connector, or ask the administrator to check this server's broker credential.",
        401,
      );
    }
    throw new BrokerError(detail ?? `The connection broker answered HTTP ${res.status}.`, res.status);
  }
}

/** Sign-in tokens for one caller on one server, minted by the broker and reused for most of their life. */
class BrokeredTokenSource implements TokenSource {
  private cached: { token: string; reuseUntil: number } | undefined;
  private inFlight: Promise<string> | undefined;
  private readonly issued = new Set<string>();

  constructor(
    private readonly registry: BrokeredRegistry,
    private readonly connectionId: string,
  ) {}

  async token(): Promise<string> {
    const now = this.registry.now();
    if (this.cached && now < this.cached.reuseUntil) return this.cached.token;
    this.inFlight ??= this.registry.broker
      .issueToken(this.registry.subjectToken(), this.connectionId)
      .then(({ token, expiresIn }) => {
        this.cached = { token, reuseUntil: this.registry.now() + expiresIn * 1000 * TOKEN_REUSE_FRACTION };
        this.issued.add(token);
        return token;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  secrets(): string[] {
    return [...this.issued];
  }
}

/**
 * One caller's connections, as the broker lists them. Refreshed on a request when the list is
 * older than HARDCHARGER_MCP_BROKER_CACHE_SECONDS (and by list_connections at once); servers
 * the broker no longer lists are closed. Each connection signs in with a token the broker
 * mints for this caller.
 */
export class BrokeredRegistry extends ConnectionRegistry {
  private callerToken = "";
  private listedAt: number | undefined;
  private refreshing: Promise<void> | undefined;
  private lastProblem: string | undefined;
  private emptyMessage: string | undefined;
  private readonly clock: () => number;

  constructor(
    config: McpConfig,
    readonly broker: BrokerClient,
    log: (message: string) => void,
    hooks: Pick<BrokerHooks, "now"> = {},
  ) {
    super(config, log, { connections: [], allowEmpty: true });
    this.clock = hooks.now ?? (() => Date.now());
  }

  now(): number {
    return this.clock();
  }

  /** The caller's current OAuth access token (verified by the transport), presented to the broker. */
  subjectToken(): string {
    return this.callerToken;
  }

  /** Records the token of the request being served: the newest one the client sent. */
  setSubjectToken(token: string): void {
    this.callerToken = token;
  }

  /** Asks the broker again when the list is stale (or always, with `force`). Never throws. */
  async refresh({ force = false }: { force?: boolean } = {}): Promise<void> {
    const ttl = (this.config.broker?.cacheSeconds ?? 0) * 1000;
    if (!force && this.listedAt !== undefined && this.now() - this.listedAt < ttl) return;
    this.refreshing ??= this.load().finally(() => {
      this.refreshing = undefined;
    });
    await this.refreshing;
  }

  private async load(): Promise<void> {
    let listed: { connections: unknown[]; message?: string };
    try {
      listed = await this.broker.listConnections(this.callerToken);
    } catch (err) {
      // Keep what the caller had; say why on the next tool call that finds nothing.
      this.lastProblem = err instanceof Error ? err.message : String(err);
      this.log(`[hardcharger-mcp] connection broker: ${this.redact(this.lastProblem)}`);
      return;
    }
    const configs: ConnectionConfig[] = [];
    const seen = new Set<string>();
    for (const raw of listed.connections) {
      const parsed = connectionSchema.safeParse(raw);
      if (!parsed.success) {
        this.log("[hardcharger-mcp] connection broker: skipped a connection with an unexpected shape");
        continue;
      }
      const c = parsed.data;
      if (!NAME_PATTERN.test(c.name) || seen.has(c.name.toLowerCase())) {
        this.log(`[hardcharger-mcp] connection broker: skipped connection ${JSON.stringify(c.name)} (invalid or repeated name)`);
        continue;
      }
      let target;
      try {
        target = parseHardchargerUri(`connection ${c.name}`, c.uri);
      } catch (err) {
        this.log(`[hardcharger-mcp] connection broker: skipped ${c.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      seen.add(c.name.toLowerCase());
      configs.push({
        name: c.name,
        ...target,
        tlsSkipVerify: false,
        defaultCatalog: c.default_catalog ?? undefined,
        defaultSchema: c.default_schema ?? undefined,
        queryTimeoutSeconds: this.config.queryTimeoutSeconds,
        id: c.id,
        label: c.label ?? undefined,
        allowWrites: c.allow_writes,
        tokenSource: new BrokeredTokenSource(this, c.id),
      });
    }
    this.lastProblem = undefined;
    this.emptyMessage = listed.message;
    this.listedAt = this.now();
    await this.replaceConnections(configs);
  }

  /** The broker's own words when it listed nothing, or why it could not be asked. */
  status(): string | undefined {
    if (this.lastProblem !== undefined) return this.lastProblem;
    if (this.names().length === 0) return this.noConnectionsMessage();
    return undefined;
  }

  protected override noConnectionsMessage(): string {
    if (this.lastProblem !== undefined) return this.lastProblem;
    return this.emptyMessage ?? "You have no Hardcharger servers to connect to.";
  }

  /** Only servers this caller already uses: listing every table would sign in to every server they can reach. */
  override resourceConnections() {
    return this.all().filter((c) => c.connectedAt !== null);
  }

  override secrets(): Array<string | undefined> {
    return [...super.secrets(), this.callerToken];
  }
}
