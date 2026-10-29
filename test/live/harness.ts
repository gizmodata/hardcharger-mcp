// Starts hardcharger-server for the live tests: the binary named by
// HARDCHARGER_MCP_TEST_SERVER_BINARY, on 127.0.0.1 and a free port, with a fresh
// administrator password that contains ':' and '@', an empty home directory (DuckDB keeps
// secrets under ~/.duckdb: a developer's own are never seen), and an environment of PATH,
// HOME, TMPDIR and HARDCHARGER_ADMIN_PASSWORD only (the server reads HARDCHARGER_* settings
// from its environment, which a developer's shell may export).
//
// The MCP server under test gets the same treatment (mcpEnv): PATH and HOME plus the
// HARDCHARGER_* settings a test names, never the developer's shell. Only
// HARDCHARGER_MCP_TEST_* variables are read here, never a generic name a shell may export
// for a real server. Without the binary every live test fails; nothing skips.

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type Connection, connect } from "@gizmodata/hardcharger";

export const binaryEnv = "HARDCHARGER_MCP_TEST_SERVER_BINARY";
export const adminUsername = "hardcharger_mcp_test";

export function serverBinary(): string {
  const binary = process.env[binaryEnv];
  if (binary === undefined || binary === "") {
    throw new Error(`FAIL: set ${binaryEnv} to a hardcharger-server binary to run the live tests (they never skip)`);
  }
  return binary;
}

export interface RunningServer {
  port: number;
  password: string;
  tls: boolean;
  /** `hardcharger://127.0.0.1:<port>`, with `?tls=false` for a plain-HTTP server. */
  uri: string;
  log(): string;
  /** Stops the process and starts it again on the same port (an in-memory database starts empty). */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export interface LaunchOptions {
  /** Flags after --host, --port, --health-port and --admin-username. */
  args?: string[];
  /** A fixed port instead of a free one. */
  port?: number;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

export async function launchServer(options: LaunchOptions = {}): Promise<RunningServer> {
  const binary = serverBinary();
  const extra = options.args ?? [];
  const port = options.port ?? (await freePort());
  const password = randomBytes(9).toString("hex") + ":p@ss:word";
  const tls = extra.includes("--tls-cert");
  const home = mkdtempSync(join(tmpdir(), "hardcharger-mcp-server-"));
  const args = ["--host", "127.0.0.1", "--port", String(port), "--health-port", "0", "--admin-username", adminUsername];
  const output: string[] = [];
  let child: ChildProcess;
  let exited: Promise<void>;
  const start = async () => {
    child = spawn(binary, [...args, ...extra], {
      cwd: home,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, HARDCHARGER_ADMIN_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await waitListening(port, child);
  };
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      child.kill("SIGTERM"); // the first drains, the second stops at once
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      await exited;
      clearTimeout(timer);
    }
  };
  const server: RunningServer = {
    port,
    password,
    tls,
    uri: `hardcharger://127.0.0.1:${port}${tls ? "" : "?tls=false"}`,
    log: () => output.join(""),
    async restart() {
      await kill();
      await start();
    },
    async stop() {
      await kill();
      rmSync(home, { recursive: true, force: true });
    },
  };
  try {
    await start();
  } catch (err) {
    await server.stop();
    throw new Error(`${String(err)}\nserver output:\n${server.log()}`, { cause: err });
  }
  return server;
}

async function waitListening(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`hardcharger-server exited with code ${child.exitCode}`);
    const up = await new Promise<boolean>((resolve) => {
      const socket = tcpConnect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`hardcharger-server did not listen on 127.0.0.1:${port} within 30s`);
}

/** An administrator connection to `server` for fixtures, through the same client the MCP server uses. */
export async function adminConnection(server: RunningServer, extra: Record<string, unknown> = {}): Promise<Connection> {
  return connect({ url: server.uri, username: adminUsername, password: server.password, ...extra });
}

/** The environment for an MCP server under test: PATH and HOME, plus exactly these settings. */
export function mcpEnv(settings: Record<string, string>): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), ...settings };
}

/** Password settings for `server` as the primary connection. */
export function passwordSettings(server: RunningServer): Record<string, string> {
  return { HARDCHARGER_URI: server.uri, HARDCHARGER_USERNAME: adminUsername, HARDCHARGER_PASSWORD: server.password };
}

/** An MCP client talking to `node dist/cli.js` over stdio with exactly `settings`. */
export async function stdioClient(settings: Record<string, string>, stderr?: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js"],
    env: mcpEnv(settings),
    stderr: "pipe",
  });
  if (stderr) transport.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
  const client = new Client({ name: "hardcharger-mcp-live", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

export function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

/** Asserts a tool call succeeded and returns its structured content. */
export async function ok<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await call(client, name, args);
  assert.equal(r.isError, undefined, `${name}: ${textOf(r)}`);
  return r.structuredContent as T;
}

/** Asserts a tool call failed, with `code` (a Chargewire error code) in its message, and returns the text. */
export async function failsWith(client: Client, name: string, args: Record<string, unknown>, code: string | RegExp): Promise<string> {
  const r = await call(client, name, args);
  assert.equal(r.isError, true, `${name} should have failed: ${textOf(r)}`);
  const text = textOf(r);
  if (typeof code === "string") assert.ok(text.includes(code), `${name}: expected ${code} in: ${text}`);
  else assert.match(text, code);
  return text;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const randomName = (prefix: string): string => `${prefix}_${randomBytes(4).toString("hex")}`;
