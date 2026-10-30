// Registry of named Hardcharger connections with a switchable default.

import { HardchargerConnection, redactSecrets, type ConnectionConfig, type McpConfig } from "./connection.js";

export class UnknownConnectionError extends Error {
  constructor(name: string, available: string[]) {
    super(`Unknown connection "${name}". Available connections: ${available.join(", ")}.`);
    this.name = "UnknownConnectionError";
  }
}

/** Raised when a caller has no connections at all (a broker listed none, or could not be reached). */
export class NoConnectionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoConnectionsError";
  }
}

export interface ConnectionSummary {
  name: string;
  /** Brokered connections: the broker's id and description. */
  id?: string;
  label?: string;
  /** The connection's hardcharger:// URI (never carries credentials). */
  uri: string;
  host: string;
  port: number;
  tls: boolean;
  auth: string;
  default_catalog: string | null;
  default_schema: string | null;
  current: boolean;
  connected: boolean;
  /** Whether write statements are accepted on this connection (HARDCHARGER_ALLOW_WRITES and the broker's say). */
  allow_writes: boolean;
}

export interface RegistryOptions {
  /** Connections to start with instead of the configured ones (a broker's). */
  connections?: ConnectionConfig[];
  /** Allow starting with no connections (a broker fills them in later). */
  allowEmpty?: boolean;
}

/**
 * Holds one lazily opened HardchargerConnection per configured server. Names are
 * matched case-insensitively. The first configured connection is the
 * initial default; `use()` switches it for the rest of the process.
 */
export class ConnectionRegistry {
  private readonly byName = new Map<string, HardchargerConnection>();
  private order: string[] = [];
  private currentName: string | null;

  constructor(
    readonly config: McpConfig,
    protected readonly log: (message: string) => void = (m) => console.error(m),
    options: RegistryOptions = {},
  ) {
    const initial = options.connections ?? config.connections;
    if (initial.length === 0 && !options.allowEmpty) throw new Error("At least one connection is required.");
    for (const c of initial) this.add(c, initial.length > 1);
    this.currentName = initial[0]?.name ?? null;
  }

  private add(c: ConnectionConfig, tagLogs: boolean): void {
    const conn = new HardchargerConnection(c, (m) => this.log(tagLogs ? `${m} [${c.name}]` : m));
    this.byName.set(c.name.toLowerCase(), conn);
    this.order.push(c.name);
  }

  /**
   * Replaces the connection set (a broker's new list). A connection whose name, id and URI are
   * unchanged keeps its open session; one that is gone or changed is closed. The current
   * connection stays current while it exists, otherwise the first one becomes current.
   */
  protected async replaceConnections(next: ConnectionConfig[]): Promise<void> {
    const closing: HardchargerConnection[] = [];
    const kept = new Map<string, HardchargerConnection>();
    for (const c of next) {
      const existing = this.byName.get(c.name.toLowerCase());
      if (existing && existing.config.id === c.id && existing.config.uri === c.uri) {
        // Same server: keep the session, take the broker's latest description and write setting.
        existing.config.label = c.label;
        existing.config.allowWrites = c.allowWrites;
        kept.set(c.name.toLowerCase(), existing);
      }
    }
    for (const [key, conn] of this.byName) if (kept.get(key) !== conn) closing.push(conn);
    this.byName.clear();
    this.order = [];
    for (const c of next) {
      const reuse = kept.get(c.name.toLowerCase());
      if (reuse) {
        this.byName.set(c.name.toLowerCase(), reuse);
        this.order.push(reuse.config.name);
      } else {
        this.add(c, true);
      }
    }
    if (this.currentName === null || !this.byName.has(this.currentName.toLowerCase())) {
      this.currentName = this.order[0] ?? null;
    }
    await Promise.all(closing.map((c) => c.close().catch(() => undefined)));
  }

  /** Why there is no connection to use (overridden by a brokered registry). */
  protected noConnectionsMessage(): string {
    return "No Hardcharger connections are configured.";
  }

  /** Names in configuration order. */
  names(): string[] {
    return [...this.order];
  }

  /** Name of the current default connection; null when there are no connections. */
  current(): string | null {
    return this.currentName;
  }

  has(name: string): boolean {
    return this.byName.has(name.trim().toLowerCase());
  }

  /** Resolves a connection by name (case-insensitive); undefined/blank means the current default. */
  get(name?: string): HardchargerConnection {
    const key = (name ?? "").trim();
    if (this.currentName === null) throw new NoConnectionsError(this.noConnectionsMessage());
    if (key === "") return this.byName.get(this.currentName.toLowerCase())!;
    const conn = this.byName.get(key.toLowerCase());
    if (!conn) throw new UnknownConnectionError(key, this.order);
    return conn;
  }

  /** Makes `name` the default for subsequent calls; returns its canonical name. */
  use(name: string): string {
    const conn = this.get(name);
    this.currentName = conn.config.name;
    return this.currentName;
  }

  all(): HardchargerConnection[] {
    return this.order.map((n) => this.byName.get(n.toLowerCase())!);
  }

  configFor(name?: string): ConnectionConfig {
    return this.get(name).config;
  }

  /** Whether write statements may run on `conn`: HARDCHARGER_ALLOW_WRITES, and the broker's say for a brokered one. */
  allowsWrites(conn: HardchargerConnection): boolean {
    return this.config.allowWrites && conn.config.allowWrites !== false;
  }

  /** Whether any connection accepts writes (decides whether execute_statement is offered). */
  anyAllowsWrites(): boolean {
    return this.all().some((c) => this.allowsWrites(c));
  }

  /** Connections whose tables are listed as resources: every configured one. */
  resourceConnections(): HardchargerConnection[] {
    return this.all();
  }

  /** Every secret from every connection plus the HTTP bearer token and the broker credential. */
  secrets(): Array<string | undefined> {
    return [...this.all().flatMap((c) => c.secrets()), this.config.mcpBearerToken, this.config.broker?.credential];
  }

  redact(text: string): string {
    return redactSecrets(text, this.secrets());
  }

  summaries(): ConnectionSummary[] {
    return this.all().map((c) => {
      const auth = c.effectiveAuth();
      const summary: ConnectionSummary = {
        name: c.config.name,
        uri: c.config.uri,
        host: c.config.host,
        port: c.config.port,
        tls: c.config.tls,
        auth: auth.method === "password" ? `password (${auth.user ?? ""})` : auth.method,
        default_catalog: c.currentSearchPath().catalog ?? null,
        default_schema: c.currentSearchPath().schema ?? null,
        current: c.config.name === this.currentName,
        connected: c.connectedAt !== null,
        allow_writes: this.allowsWrites(c),
      };
      if (c.config.id !== undefined) summary.id = c.config.id;
      if (c.config.label !== undefined) summary.label = c.config.label;
      return summary;
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.all().map((c) => c.close().catch(() => undefined)));
  }
}
