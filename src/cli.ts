#!/usr/bin/env node
// Entrypoint: `hardcharger-mcp [--transport stdio|http] [--port N] [--host H]`.

import { parseArgs } from "node:util";

function usage(): string {
  return [
    "Usage: hardcharger-mcp [--transport stdio|http] [--port N] [--host H]",
    "",
    "  --transport  stdio (default) or http (Streamable HTTP on /mcp)",
    "  --port       HTTP port (default 3000; http transport only)",
    "  --host       HTTP bind address (default 127.0.0.1; http transport only)",
    "  --version    print the version",
    "  --help       show this help",
    "",
    "Configuration is read from HARDCHARGER_* environment variables (see README):",
    "HARDCHARGER_URI=hardcharger://host[:port][?tls=false] and one credential.",
    "HTTP transport authentication: HARDCHARGER_MCP_OAUTH_ISSUER (+ HARDCHARGER_MCP_PUBLIC_URL) for OAuth,",
    "or HARDCHARGER_MCP_BEARER_TOKEN for a static token.",
  ].join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      transport: { type: "string", default: "stdio" },
      port: { type: "string", default: "3000" },
      host: { type: "string", default: "127.0.0.1" },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(usage());
    return;
  }

  const { PACKAGE_VERSION } = await import("./version.js");
  if (values.version) {
    console.log(PACKAGE_VERSION);
    return;
  }

  const transport = values.transport;
  if (transport !== "stdio" && transport !== "http") {
    console.error(`Unknown --transport "${transport}".\n\n${usage()}`);
    process.exit(2);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid --port "${values.port}".`);
    process.exit(2);
  }

  const { parseConfig, ConfigError } = await import("./connection.js");
  let config;
  try {
    config = parseConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[hardcharger-mcp] configuration error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const { startStdio, startHttp } = await import("./transports.js");
  if (transport === "stdio") {
    await startStdio(config);
  } else {
    await startHttp(config, { host: values.host, port });
  }
}

main().catch((err) => {
  console.error(`[hardcharger-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
