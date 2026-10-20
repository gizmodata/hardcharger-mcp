// Runs every example in README.md marked `<!-- example: NAME -->` against a live
// hardcharger-server, with the MCP server installed from the packed tarball as a user would
// install it (`npx -y @gizmodata/hardcharger-mcp` becomes that install's `hardcharger-mcp`, the
// one substitution: the package is not on npm yet). The examples connect to
// hardcharger://localhost, so the server runs on 127.0.0.1:31337 as administrator
// `hardcharger` with password `change-me`, an empty home directory and nothing else in its
// environment. An example marked in the README that this script doesn't know fails the run,
// and so does a README with no examples.
//
//   HARDCHARGER_MCP_TEST_SERVER_BINARY=/path/to/hardcharger-server node scripts/run-examples.mjs
//
// Needs `npm run build` and the client tarballs in .clients/ (scripts/install-clients.sh).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { connect } from "@gizmodata/hardcharger";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = resolve(import.meta.dirname, "..");
const binary = process.env.HARDCHARGER_MCP_TEST_SERVER_BINARY;
if (!binary) {
  console.error("FAIL: set HARDCHARGER_MCP_TEST_SERVER_BINARY to a hardcharger-server binary");
  process.exit(1);
}
const PACKAGE = "@gizmodata/hardcharger-mcp";
const ADMIN = { username: "hardcharger", password: "change-me" };

// --- The README's examples -------------------------------------------------------------------
const readme = readFileSync(join(root, "README.md"), "utf8");
const examples = [...readme.matchAll(/<!-- example: ([a-z0-9-]+) -->\n```(\w+)\n([\s\S]*?)\n```/gu)].map((m) => ({
  name: m[1],
  lang: m[2],
  code: m[3],
}));
const markers = [...readme.matchAll(/<!-- example: /gu)].length;
assert.equal(examples.length, markers, "every example marker is followed by a code block");
assert.ok(examples.length > 0, "README.md has examples");

/** Shell words of a bash example: continuation lines joined, single and double quotes honoured. */
function shellWords(code) {
  const text = code.replace(/\\\n/gu, " ");
  const words = [];
  let word = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      assert.ok(end > i, `unterminated quote in: ${code}`);
      word = (word ?? "") + text.slice(i + 1, end);
      i = end;
    } else if (/\s/u.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + ch;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** `K=V ... npx -y @gizmodata/hardcharger-mcp args...`: the environment and the arguments. */
function envAndArgs(code) {
  const words = shellWords(code);
  const env = {};
  let i = 0;
  for (; i < words.length && /^[A-Z_][A-Z0-9_]*=/u.test(words[i]); i++) {
    const eq = words[i].indexOf("=");
    env[words[i].slice(0, eq)] = words[i].slice(eq + 1);
  }
  assert.deepEqual(words.slice(i, i + 3), ["npx", "-y", PACKAGE], `the example runs ${PACKAGE} with npx`);
  return { env, args: words.slice(i + 3) };
}

// --- The package, installed from its tarball ---------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "hardcharger-mcp-examples-"));
const serverHome = join(work, "server-home");
const exampleDir = join(work, "cwd");
execFileSync("mkdir", ["-p", serverHome, exampleDir]);
const packed = execFileSync("npm", ["pack", "--pack-destination", work, "--silent"], { cwd: root, encoding: "utf8" })
  .trim()
  .split("\n")
  .pop();
const clients = readdirSync(join(root, ".clients"))
  .filter((f) => f.endsWith(".tgz"))
  .map((f) => join(root, ".clients", f));
assert.equal(clients.length, 2, "the two client tarballs in .clients/ (scripts/install-clients.sh)");
const install = join(work, "install");
execFileSync("mkdir", ["-p", install]);
writeFileSync(join(install, "package.json"), JSON.stringify({ name: "examples", private: true }));
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent", join(work, packed), ...clients], { cwd: install, stdio: "inherit" });
const bin = join(install, "node_modules", ".bin", "hardcharger-mcp");
console.log(`installed ${packed} -> ${bin}`);

/** A process environment of PATH and HOME only, plus the example's settings. */
const cleanEnv = (env) => ({ PATH: process.env.PATH, HOME: work, ...env });

// --- hardcharger-server on 31337 -----------------------------------------------------------
let server = null;
async function startServer(args = [], checkTls = undefined) {
  await stopServer();
  // A cluster id only this server has: the examples must reach it, not another server that
  // happens to listen on 31337 (one bound to every interface can coexist with ours on 127.0.0.1).
  const tag = randomUUID();
  const child = spawn(binary, ["--host", "127.0.0.1", "--port", "31337", "--health-port", "0", "--admin-username", ADMIN.username, "--cluster-id", tag, ...args], {
    cwd: serverHome,
    env: { PATH: process.env.PATH, HOME: serverHome, TMPDIR: serverHome, HARDCHARGER_ADMIN_PASSWORD: ADMIN.password },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (d) => (log += d));
  const exited = new Promise((r) => child.once("exit", r));
  for (let i = 0; i < 300 && !/Hardcharger is ready/u.test(log); i++) {
    if (child.exitCode !== null) throw new Error(`hardcharger-server exited: ${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(log, /Hardcharger is ready/u, log);
  server = { child, exited };
  const check = await connect({
    url: checkTls ? "hardcharger://127.0.0.1" : "hardcharger://127.0.0.1?tls=false",
    ...ADMIN,
    ...(checkTls ? { tls: checkTls } : {}),
  });
  try {
    const t = await check.query("SELECT value FROM hardcharger_settings() WHERE name = 'hardcharger.cluster_id'");
    assert.equal(t.getChildAt(0)?.get(0), tag, "127.0.0.1:31337 answers from the server this script started");
  } finally {
    await check.close();
  }
}
async function stopServer() {
  if (!server) return;
  server.child.kill("SIGTERM");
  server.child.kill("SIGTERM");
  await server.exited;
  server = null;
}

async function stdioClient(env, args = []) {
  const transport = new StdioClientTransport({ command: bin, args, env: cleanEnv(env), cwd: exampleDir, stderr: "pipe" });
  const client = new Client({ name: "readme-examples", version: "0.0.0" });
  await client.connect(transport);
  return client;
}
async function tool(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text ?? "").join("\n");
  assert.equal(r.isError, undefined, `${name}: ${text}`);
  return { structured: r.structuredContent, text };
}
async function signedInAs(env, user, method) {
  const client = await stdioClient(env);
  try {
    const info = (await tool(client, "server_info")).structured;
    assert.equal(info.user, user);
    assert.equal(info.auth_method, method);
    const one = (await tool(client, "run_query", { sql: "SELECT 42 AS answer" })).structured;
    assert.deepEqual(one.rows, [[42]]);
  } finally {
    await client.close();
  }
}

/** Starts the HTTP transport; resolves with its /mcp URL. */
async function httpServer(env, args) {
  const child = spawn(bin, args, { env: cleanEnv(env), cwd: exampleDir, stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise((resolveUrl, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`http server did not start: ${buf}`)), 20000);
    child.stderr.on("data", (d) => {
      buf += d;
      const m = /listening on (http:\/\/[^ ]+\/mcp)/u.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[1]);
      }
    });
    child.once("exit", (code) => reject(new Error(`exited (${code}): ${buf}`)));
  });
  return { url, stop: () => child.kill("SIGTERM") };
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

// --- The examples ----------------------------------------------------------------------------
const handlers = {
  async "tool-call"(code) {
    const args = JSON.parse(code);
    const admin = await connect({ url: "hardcharger://localhost?tls=false", ...ADMIN });
    await admin.execute("CREATE OR REPLACE TABLE customers (id INTEGER, name VARCHAR, created_at DATE, region VARCHAR)");
    await admin.execute(
      "INSERT INTO customers VALUES (1, 'Ada', DATE '2024-03-01', 'EMEA'), (2, 'Bo', DATE '2023-12-31', 'EMEA'), (3, 'Cy', DATE '2024-05-05', 'AMER')",
    );
    await admin.close();
    const client = await stdioClient({ HARDCHARGER_URI: "hardcharger://localhost?tls=false", HARDCHARGER_USERNAME: ADMIN.username, HARDCHARGER_PASSWORD: ADMIN.password });
    try {
      const r = (await tool(client, "run_query", args)).structured;
      assert.deepEqual(r.rows, [[1, "Ada"]], "the date string is compared as a date");
    } finally {
      await client.close();
    }
  },

  async "claude-code"(code) {
    const words = shellWords(code);
    assert.deepEqual(words.slice(0, 4), ["claude", "mcp", "add", "hardcharger"]);
    const env = {};
    let i = 4;
    for (; words[i] === "-e"; i += 2) {
      const eq = words[i + 1].indexOf("=");
      env[words[i + 1].slice(0, eq)] = words[i + 1].slice(eq + 1);
    }
    assert.deepEqual(words.slice(i), ["--", "npx", "-y", PACKAGE]);
    await signedInAs(env, ADMIN.username, "password");
  },

  async "desktop-json"(code) {
    const entry = JSON.parse(code).mcpServers.hardcharger;
    assert.equal(entry.command, "npx");
    assert.deepEqual(entry.args, ["-y", PACKAGE]);
    await signedInAs(entry.env, ADMIN.username, "password");
  },

  async mtls(code) {
    const { env, args } = envAndArgs(code);
    assert.deepEqual(args, []);
    // The files the example names, from a throwaway CA, in the directory it runs in.
    const { makeCAWithCleanup, clientEmail } = await import(join(root, "test", "live", "certs.ts"));
    const ca = makeCAWithCleanup();
    try {
      writeFileSync(join(exampleDir, env.HARDCHARGER_MTLS_CERT), ca.clientCertPem);
      writeFileSync(join(exampleDir, env.HARDCHARGER_MTLS_KEY), ca.clientKeyPem);
      writeFileSync(join(exampleDir, env.HARDCHARGER_TLS_ROOTS), ca.caPem);
      await startServer([
        "--tls-cert", ca.serverCert, "--tls-key", ca.serverKey, "--mtls-ca-cert", ca.caFile,
        "--mtls-certificate-sign-in", "--mtls-admin-identities", clientEmail,
      ], { ca: ca.caPem, cert: ca.clientCertPem, key: ca.clientKeyPem });
      await signedInAs(env, clientEmail, "mtls");
    } finally {
      await startServer();
      ca.remove();
    }
  },

  async "http-bearer"(code) {
    const { env, args } = envAndArgs(code);
    const http = await httpServer(env, args);
    try {
      assert.equal(http.url, "http://127.0.0.1:3000/mcp");
      const refused = await fetch(http.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: initialize,
      });
      assert.equal(refused.status, 401);
      const client = new Client({ name: "readme-http", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(http.url), {
          requestInit: { headers: { authorization: `Bearer ${env.HARDCHARGER_MCP_BEARER_TOKEN}` } },
        }),
      );
      const r = (await tool(client, "run_query", { sql: "SELECT 7 AS seven" })).structured;
      assert.deepEqual(r.rows, [[7]]);
      await client.close();
    } finally {
      http.stop();
    }
  },

  async "http-oauth"(code) {
    // The provider is the example's (Entra ID); what runs here is everything up to it: the
    // configuration is accepted, the server listens, publishes the protected-resource
    // metadata, and challenges a request without a token.
    const { env, args } = envAndArgs(code);
    const http = await httpServer(env, args.map((a) => (a === "0.0.0.0" ? "127.0.0.1" : a)));
    try {
      const origin = new URL(http.url).origin;
      const meta = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
      assert.equal(meta.resource, env.HARDCHARGER_MCP_PUBLIC_URL);
      assert.ok(meta.scopes_supported.includes("offline_access"), JSON.stringify(meta));
      assert.deepEqual(meta.authorization_servers, ["https://mcp.example.com/oauth"], "the token proxy's facade");
      const challenge = await fetch(http.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: initialize,
      });
      assert.equal(challenge.status, 401);
      assert.match(challenge.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/mcp\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/u);
    } finally {
      http.stop();
    }
  },

  async multi(code) {
    const { env, args } = envAndArgs(code);
    assert.deepEqual(args, []);
    const client = await stdioClient(env);
    try {
      const listed = (await tool(client, "list_connections")).structured;
      assert.deepEqual(listed.connections.map((c) => c.name), ["default", "staging", "dev-eu"]);
      assert.equal(listed.connections[1].auth, "token");
      const onDev = (await tool(client, "run_query", { sql: "SELECT 1 AS one", connection: "dev-eu" })).structured;
      assert.deepEqual(onDev.rows, [[1]]);
    } finally {
      await client.close();
    }
  },
};

let ran = 0;
let failed = 0;
try {
  await startServer();
  for (const example of examples) {
    const handler = handlers[example.name];
    try {
      assert.ok(handler, `no runner for the README example "${example.name}": add one to scripts/run-examples.mjs`);
      await handler(example.code);
      ran++;
      console.log(`ok   ${example.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${example.name}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  }
} finally {
  await stopServer();
  rmSync(work, { recursive: true, force: true });
}
console.log(`README examples: ${ran} ran, ${failed} failed, of ${examples.length}`);
if (failed > 0 || ran === 0) process.exit(1);
