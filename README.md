<p align="center">
  <a href="https://github.com/gizmodata/hardcharger">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hardcharger-banner-dark.png">
      <img src="docs/assets/hardcharger-banner-light.png" alt="Hardcharger™" width="400">
    </picture>
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/npm-%40gizmodata%2Fhardcharger--mcp-cb3837.svg?logo=npm" alt="npm: @gizmodata/hardcharger-mcp">
  <img src="https://img.shields.io/badge/MCP-server%20%2B%20Claude%20Desktop%20extension-d97757.svg" alt="MCP server and Claude Desktop extension">
  <img src="https://img.shields.io/badge/TypeScript-ESM-3178C6.svg?logo=typescript&logoColor=white" alt="TypeScript, ESM">
  <img src="https://img.shields.io/badge/Node-%E2%89%A522.19-339933.svg?logo=node.js&logoColor=white" alt="Node 22.19 or later">
  <a href="https://github.com/gizmodata/chargewire"><img src="https://img.shields.io/badge/protocol-Chargewire%201.0.0-31a8db.svg" alt="Chargewire protocol"></a>
  <a href="https://github.com/gizmodata/hardcharger-js"><img src="https://img.shields.io/badge/built%20on-Hardcharger%20JS-31a8db.svg" alt="Built on the Hardcharger JavaScript client"></a>
  <a href="https://github.com/gizmodata/hardcharger"><img src="https://img.shields.io/badge/server-Hardcharger-f15a24.svg" alt="Hardcharger"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-brightgreen.svg" alt="Apache 2.0 license"></a>
  <a href="https://gizmodata.com"><img src="https://img.shields.io/badge/by-GizmoData%E2%84%A2-f15a24.svg" alt="GizmoData™"></a>
</p>

<h3 align="center">Explore and query Hardcharger™ from Claude Desktop, Claude Code and any MCP client.</h3>

---

## 🔌 What is it?

A [Model Context Protocol](https://modelcontextprotocol.io) server and Claude Desktop extension
for [Hardcharger™](https://github.com/gizmodata/hardcharger), GizmoData™'s DuckDB 2.0 server. It
lets Claude Desktop, Claude Code and any other MCP client explore your schema and run SQL against
a Hardcharger server you can reach from your machine (including private networks over VPN), or,
over Streamable HTTP, serves a whole team behind OAuth.

It speaks [Chargewire](https://github.com/gizmodata/chargewire), Hardcharger's HTTP protocol, through
the Hardcharger JavaScript client ([`@gizmodata/hardcharger`](https://github.com/gizmodata/hardcharger-js)):
pure JavaScript, no native driver, so one extension bundle serves every platform Claude Desktop
runs on. It is the Hardcharger port of
[gizmosql-mcp](https://github.com/gizmodata/gizmosql-mcp), with the same tools and settings
(`HARDCHARGER_*` instead of `GIZMOSQL_*`; see [CHANGELOG.md](CHANGELOG.md) for what changed).

> **Status: 2.1.0, with Hardcharger 2.3.0.** Built on `@gizmodata/hardcharger` 2.1.0 (hardcharger-js
> `1a524f6`, on `@gizmodata/chargewire` 2.0.0, chargewire-js `1ea10dd`, Chargewire protocol 1.0.0);
> tested against the image of Hardcharger's main branch and against Hardcharger 2.2.0, released
> before the protocol was renamed to Chargewire.

## 🧰 Tools

| Tool | What it does |
| --- | --- |
| `list_connections()` | Configured Hardcharger connections and which one is current (never credentials) |
| `use_connection(name)` | Makes a connection the default for subsequent calls |
| `list_catalogs` | Catalogs (attached databases) visible to the user |
| `list_schemas(catalog?, include_system?)` | Schemas, optionally in one catalog; system schemas (`information_schema`, `pg_catalog`, `pg_toast`, `pg_temp_*`) are hidden unless `include_system` is true |
| `list_tables(catalog?, schema?, like?)` | Tables and views with their type; `like` is a SQL LIKE pattern |
| `describe_table(table, schema?, catalog?)` | Columns, types, nullability, constraints, estimated row count |
| `use_schema(catalog?, schema?)` | Sets the session's default catalog/schema for unqualified table names |
| `run_query(sql, params?, max_rows?)` | Runs a query; returns a Markdown table plus structured JSON, capped at `max_rows` |
| `explain_query(sql)` | DuckDB `EXPLAIN` plan without executing |
| `execute_statement(sql, params?)` | DML/DDL with affected-row count. Only registered when writes are enabled |
| `server_info()` | Hardcharger/DuckDB versions, signed-in user and role, connection URI, limits, extension version |
| `login_sso(wait_seconds?)` | Browser sign-in through the server's identity provider. Only registered when SSO is enabled |

Every tool except `list_connections` and `use_connection` also accepts an optional `connection`
argument naming one of the configured servers (see [Multiple connections](#-multiple-connections)).
A resource template, `hardcharger://{connection}/schema/{catalog}/{schema}/{table}`, returns the
DDL of a table or view.

### Query parameters

`run_query` and `execute_statement` accept a `params` array bound positionally to `?` (or `$1`,
`$2`, ...) placeholders. Values travel to the server as bound parameters, never as interpolated SQL
text, so use placeholders for any literal that comes from user input or from data returned by an
earlier query.

- Plain JSON values: string, number, boolean, `null`. The server types each value from where it is
  used, so a date string compared with (or inserted into) a `DATE` or `TIMESTAMP` column is read as
  a date.
- Explicit types: `{"type": "bigint", "value": "9223372036854775807"}` (exact beyond 2^53),
  `{"type": "date", "value": "2024-01-02"}`, `{"type": "timestamp", ...}`,
  `{"type": "binary", "value": "<base64>"}`, plus `string`, `number`, `boolean` and `null`. A date,
  timestamp or binary parameter binds the row as Arrow data through a prepared statement.
- A placeholder whose type nothing gives, such as `SELECT ?`, is text unless typed or cast:
  `SELECT ?::INTEGER`.

Example `run_query` arguments:

<!-- example: tool-call -->
```json
{
  "sql": "SELECT id, name FROM customers WHERE created_at >= ? AND region = ? LIMIT 20",
  "params": ["2024-01-01", "EMEA"]
}
```

## 🚀 Installation

### Claude Desktop extension (`.mcpb`)

1. Download `hardcharger-mcp.mcpb` from this repository's
   [Releases](https://github.com/gizmodata/hardcharger-mcp/releases) (each release also carries a
   versioned `hardcharger-mcp-<version>.mcpb` and `.sha256` checksums), or build it with
   `npm run build:mcpb` (see [Building and testing](#%EF%B8%8F-building-and-testing)).
2. Double-click the file, or in Claude Desktop open **Settings → Extensions → Advanced settings →
   Install Extension…** and pick it.
3. Fill in the settings: the server's URI (`hardcharger://db.example.com`) and one credential.
   Credentials are marked sensitive and kept in your operating system's keychain.
4. In a chat, open the **+** menu, choose **Connectors** and make sure **Hardcharger** is on.

No Node.js installation is needed: Claude Desktop runs the extension with its own runtime, and the
bundle holds no native code.

### Claude Code

<!-- example: claude-code -->
```bash
claude mcp add hardcharger \
  -e HARDCHARGER_URI='hardcharger://localhost?tls=false' \
  -e HARDCHARGER_USERNAME=hardcharger \
  -e HARDCHARGER_PASSWORD=change-me \
  -- npx -y @gizmodata/hardcharger-mcp
```

Use `-s user` to make it available in every project. Node.js 22.19 or newer is required when
running through `npx`. Installed globally (`npm install -g @gizmodata/hardcharger-mcp`), the command
is `hardcharger-mcp`: use `-- hardcharger-mcp` instead of `npx -y @gizmodata/hardcharger-mcp`.

### `claude_desktop_config.json` (manual JSON)

<!-- example: desktop-json -->
```json
{
  "mcpServers": {
    "hardcharger": {
      "command": "npx",
      "args": ["-y", "@gizmodata/hardcharger-mcp"],
      "env": {
        "HARDCHARGER_URI": "hardcharger://localhost?tls=false",
        "HARDCHARGER_USERNAME": "hardcharger",
        "HARDCHARGER_PASSWORD": "change-me"
      }
    }
  }
}
```

These examples connect to a local development server started with
`HARDCHARGER_ADMIN_USERNAME=hardcharger HARDCHARGER_ADMIN_PASSWORD=change-me hardcharger-server`
(the [Hardcharger README](https://github.com/gizmodata/hardcharger) has Docker and the
installers). A real server uses TLS: `hardcharger://db.example.com`.

## 🔐 Signing in

Each connection takes one credential:

| Setting | Sign-in |
| --- | --- |
| `HARDCHARGER_USERNAME` + `HARDCHARGER_PASSWORD` | Password (any character, `:` and `@` included) |
| `HARDCHARGER_TOKEN` | A signed sign-in token the server trusts (`--token-allowed-issuer` with `--token-jwks-uri` or `--token-signature-verify-cert-path`), sent with Chargewire's `token_exchange` grant. The same token also works as the password of user `token`. Its `role` claim (`admin`, `user`, `readonly`) decides what it may do |
| `HARDCHARGER_MTLS_CERT` + `HARDCHARGER_MTLS_KEY` | Client certificate sign-in (mutual TLS) on a server started with `--mtls-certificate-sign-in`: the certificate is the credential. With a password or token beside them, the certificate only admits the connection |
| `HARDCHARGER_ENABLE_SSO=true` | No stored credential: `login_sso` signs in through the server's identity provider in your browser |

A client certificate from a private CA usually comes with that CA for the server's certificate:

<!-- example: mtls -->
```bash
HARDCHARGER_URI=hardcharger://localhost \
HARDCHARGER_MTLS_CERT=client.pem HARDCHARGER_MTLS_KEY=client-key.pem \
HARDCHARGER_TLS_ROOTS=server-ca.pem \
npx -y @gizmodata/hardcharger-mcp
```

The identity is the certificate's e-mail SAN unless the server says otherwise; it must be one of
the server's `--mtls-admin-identities` or, under access control, a user of its store. Refusals keep
the server's codes: `unknown_certificate_identity` (401) for a certificate that names no user, and
`client_transport_error` when the handshake fails (an untrusted server certificate without
`HARDCHARGER_TLS_ROOTS` or `HARDCHARGER_TLS_SKIP_VERIFY`).

**Browser sign-in (`login_sso`).** On a server started with `--oauth-client-id` (and its identity
provider settings), `login_sso` opens the provider's login page through the server's Chargewire
browser sign-in (on the connection's own URI and port), waits for you to finish, and connects with
the Hardcharger access token the server hands out, kept in memory only; when it expires, call
`login_sso` again. A refusal names its code (`access_denied`, `identity_provider_error`,
`invalid_credentials` for a user the server doesn't allow).
`HARDCHARGER_BROWSER` names the program that opens the page (default: `open`, `xdg-open`, or the
Windows URL handler), as in the Hardcharger CLI. It runs on the stdio transport only (over HTTP it
would open a browser on the server).

## 🌐 Streamable HTTP (remote connector)

The same server can listen over Streamable HTTP for MCP clients that connect over the network,
such as a Claude.ai custom connector. The MCP endpoint is `/mcp`; `/healthz` answers health checks.
Put it behind TLS (an ingress or reverse proxy) before exposing it beyond localhost. Requests are
authenticated in one of two ways.

**OAuth (recommended).** Any OpenID Connect provider that issues signed JWT access tokens works:
Microsoft Entra ID, Okta (custom authorization server), Auth0, Keycloak, Cognito, Clerk. The server
is an OAuth 2.1 *resource server*: it verifies each bearer token against the provider's JWKS
(issuer, audience, signature, expiry) and serves the RFC 9728 metadata at
`/.well-known/oauth-protected-resource[/mcp]` so clients find the provider on their own. The token
is never forwarded; the Hardcharger connection uses the configured service credentials.

<!-- example: http-oauth -->
```bash
HARDCHARGER_URI=hardcharger://hardcharger.internal.example.com \
HARDCHARGER_USERNAME=mcp_service HARDCHARGER_PASSWORD='service-password' \
HARDCHARGER_MCP_PUBLIC_URL=https://mcp.example.com/mcp \
HARDCHARGER_MCP_OAUTH_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0 \
HARDCHARGER_MCP_OAUTH_AUDIENCE=<application-client-id> \
HARDCHARGER_MCP_OAUTH_SCOPES='https://mcp.example.com/mcp/access_as_user openid profile email offline_access' \
HARDCHARGER_MCP_OAUTH_TOKEN_PROXY=true \
HARDCHARGER_MCP_OAUTH_AUTHORIZED_EMAILS='*@example.com' \
npx -y @gizmodata/hardcharger-mcp --transport http --host 0.0.0.0 --port 3000
```

Then add `https://mcp.example.com/mcp` as a custom connector in Claude (Customize > Connectors).
Claude sends that URL as the OAuth `resource`, discovers the provider from the metadata, runs the
authorization-code flow with PKCE, and retries with the token. Each tool call is logged with the
caller's identity, and `server_info` reports it as `authenticated_user`. Each user gets their own
Hardcharger session, current connection and search path (`HARDCHARGER_MCP_SESSION_IDLE_SECONDS`,
`HARDCHARGER_MCP_MAX_SESSIONS`); the first result after an expired session says so.

Claude requests exactly the scopes named in `HARDCHARGER_MCP_OAUTH_SCOPES`, so include
`offline_access` alongside the API scope: it is what makes the provider issue a refresh token. The
server warns at startup when the scope list lacks it and logs every rejected token with the reason.

**Token proxy (required for Microsoft Entra ID).** Claude's refresh request carries only the OpenID
Connect scopes, and Entra refuses it with `AADSTS90009` because it names no resource, so the
connector stops working when the access token expires (about an hour). With
`HARDCHARGER_MCP_OAUTH_TOKEN_PROXY=true` the server publishes an authorization-server metadata
document at `<public origin>/oauth` and proxies the token endpoint at `<public origin>/oauth/token`:
`refresh_token` grants get the configured API scope and `offline_access` added, everything else
passes through, and sign-in still happens at the provider. See
[anthropics/claude-ai-mcp#840](https://github.com/anthropics/claude-ai-mcp/issues/840).

Provider notes: **Microsoft Entra ID** has no dynamic client registration, so the person adding the
connector enters the app registration's client ID and secret under *Advanced settings* (redirect URI
`https://claude.ai/api/mcp/auth_callback`, *Expose an API* with the MCP URL as Application ID URI
and a scope such as `access_as_user`, `requestedAccessTokenVersion` 2; v2 tokens carry the client ID
as `aud`). **Okta** needs a custom authorization server; **Auth0** an API with the audience;
**Keycloak** works out of the box; **Clerk** issues JWT access tokens by default. Providers with
opaque access tokens (Google) are not supported in this mode.

**Static bearer token.** For a quick shared secret instead of OAuth, set
`HARDCHARGER_MCP_BEARER_TOKEN`; every request must then send `Authorization: Bearer <token>`. The
two modes are mutually exclusive. With neither set the endpoint is unauthenticated, for local use
only.

<!-- example: http-bearer -->
```bash
HARDCHARGER_URI='hardcharger://localhost?tls=false' \
HARDCHARGER_USERNAME=hardcharger HARDCHARGER_PASSWORD=change-me \
HARDCHARGER_MCP_BEARER_TOKEN=a-long-random-secret \
npx -y @gizmodata/hardcharger-mcp --transport http --port 3000
```

### Container image and Helm chart

[`Dockerfile`](Dockerfile) builds an image whose entrypoint runs the HTTP transport on port 3000, and
[`charts/hardcharger-mcp`](charts/hardcharger-mcp) deploys it with a ConfigMap for the
`HARDCHARGER_*` settings, a Secret (or `existingSecret`) for credentials, and an optional Ingress.
The release workflow builds both and attaches the packaged chart to the GitHub Release, and pushes
the image and chart to GHCR when the repository variable `IMAGE_PUBLISH_ENABLED` is `true`.

```bash
helm upgrade --install hardcharger-mcp charts/hardcharger-mcp \
  --namespace hardcharger-mcp --create-namespace --values values.yaml
```

## ⚙️ Configuration

All settings are environment variables; the extension's settings screen maps onto the same names.
Only `HARDCHARGER_*` names are read.

| Variable | Default | Description |
| --- | --- | --- |
| `HARDCHARGER_URI` | required | `hardcharger://host[:port][/prefix][?tls=false]`: TLS to port 31337 unless the URI says otherwise |
| `HARDCHARGER_CONNECTION_NAME` | `default` | Name of this connection (used with the `connection` tool argument) |
| `HARDCHARGER_USERNAME` / `HARDCHARGER_PASSWORD` | | Password sign-in |
| `HARDCHARGER_TOKEN` | | A signed sign-in token (the `token_exchange` grant) |
| `HARDCHARGER_MTLS_CERT` / `HARDCHARGER_MTLS_KEY` | | Client certificate and key (PEM files) for mutual TLS; alone, certificate sign-in |
| `HARDCHARGER_TLS_ROOTS` | system | CA bundle (PEM file) for the server's certificate |
| `HARDCHARGER_TLS_SKIP_VERIFY` | `false` | Accept self-signed or untrusted certificates |
| `HARDCHARGER_DEFAULT_CATALOG` | | Catalog for unqualified table names (optional) |
| `HARDCHARGER_DEFAULT_SCHEMA` | | Schema for unqualified table names (optional) |
| `HARDCHARGER_ALLOW_WRITES` | `false` | Register `execute_statement` and let `run_query` run non-read statements |
| `HARDCHARGER_MAX_ROWS` | `500` | Hard cap on rows returned by `run_query` |
| `HARDCHARGER_MAX_CELL_CHARS` | `200` | Cells longer than this are truncated with `…` |
| `HARDCHARGER_QUERY_TIMEOUT_SECONDS` | `60` | Per-statement timeout, enforced by the server; `0` disables it |
| `HARDCHARGER_ENABLE_SSO` | `false` | Register the `login_sso` tool (credentials may then be left empty) |
| `HARDCHARGER_BROWSER` | platform's | Program that opens the sign-in page for `login_sso` |
| `HARDCHARGER_MCP_BEARER_TOKEN` | | HTTP transport: static bearer token (mutually exclusive with OAuth) |
| `HARDCHARGER_MCP_PUBLIC_URL` | | HTTP transport with OAuth: public URL of the `/mcp` endpoint, the OAuth resource identifier |
| `HARDCHARGER_MCP_OAUTH_ISSUER` | | HTTP transport: OpenID Connect issuer URL; setting it enables OAuth |
| `HARDCHARGER_MCP_OAUTH_AUDIENCE` | public URL | Accepted `aud` values, comma-separated (Entra ID v2 tokens: the client ID) |
| `HARDCHARGER_MCP_OAUTH_SCOPES` | | Scopes advertised to clients; include `offline_access` so a refresh token is issued |
| `HARDCHARGER_MCP_OAUTH_AUTHORIZED_EMAILS` | | Glob allowlist of sign-in emails, e.g. `*@example.com` |
| `HARDCHARGER_MCP_OAUTH_TOKEN_PROXY` | `false` | Proxy the token endpoint so `refresh_token` grants carry the API scope (required for Entra ID) |
| `HARDCHARGER_MCP_OAUTH_JWKS_URI` | discovered | JWKS endpoint, when discovery from the issuer is not possible |
| `HARDCHARGER_MCP_OAUTH_USER_CLAIM` | `email,preferred_username,upn,name,sub` | Claims tried in order to name the caller |
| `HARDCHARGER_MCP_OAUTH_ALLOW_INSECURE` | `false` | Accept `http://` issuer and public URLs (local testing only) |
| `HARDCHARGER_MCP_SESSION_IDLE_SECONDS` | `1800` | HTTP transport with OAuth: close a user's session after this long without a request |
| `HARDCHARGER_MCP_MAX_SESSIONS` | `200` | HTTP transport with OAuth: cap on concurrent user sessions |
| `HARDCHARGER_2_URI`, `HARDCHARGER_3_URI`, … | | Additional connections, see below |
| `HARDCHARGER_CONNECTIONS` | | Comma-separated names of further connections, see below |

The default catalog and schema are optional session options: if one does not exist, the server
still starts and reports the problem (with the catalogs it found) in `server_info`. In a chat,
`use_schema` or a plain `USE catalog.schema` switches for the rest of the session.

### 🔀 Multiple connections

- **Claude Desktop extension.** The settings screen has two extra slots, *Connection 2* and
  *Connection 3*, each with its own name, URI, credentials and default catalog/schema. Leave a
  slot's URI blank to disable it.
- **Environment variables.** The slots map to `HARDCHARGER_2_*` and `HARDCHARGER_3_*`
  (`HARDCHARGER_2_URI`, `HARDCHARGER_2_NAME`, `HARDCHARGER_2_USERNAME`, `HARDCHARGER_2_PASSWORD`,
  `HARDCHARGER_2_TOKEN`, ...). For any number of servers, list names in `HARDCHARGER_CONNECTIONS`
  and define each one with the same variables prefixed by the upper-cased name (non-alphanumerics
  become `_`; `mcp` is reserved):

<!-- example: multi -->
```bash
HARDCHARGER_URI='hardcharger://localhost?tls=false' \
HARDCHARGER_USERNAME=hardcharger HARDCHARGER_PASSWORD=change-me \
HARDCHARGER_CONNECTIONS=staging,dev-eu \
HARDCHARGER_STAGING_URI=hardcharger://hardcharger.staging.example.com \
HARDCHARGER_STAGING_TOKEN='<a sign-in token>' \
HARDCHARGER_DEV_EU_URI='hardcharger://localhost?tls=false' \
HARDCHARGER_DEV_EU_USERNAME=hardcharger HARDCHARGER_DEV_EU_PASSWORD=change-me \
npx -y @gizmodata/hardcharger-mcp
```

In a chat, `list_connections` shows what is configured, `use_connection` switches the default, and
every tool accepts a per-call `connection` argument. Connections open lazily; the row cap, timeout
and read-only settings apply to all of them, while each server's user privileges still govern what
that connection may do.

## 🛡️ Read-only model and security

By default the server refuses anything that is not a read. `sql-guard.ts` classifies each statement
and only lets `SELECT`, `WITH … SELECT`, `FROM`, `VALUES`, `SHOW`, `DESCRIBE`, `SUMMARIZE`,
`EXPLAIN`, read-style `PRAGMA` and `USE` (search path only) through. CTEs that end in DML, `COPY`,
`ATTACH`, `INSTALL`, `LOAD`, `SET`, `CALL`, transactions and multi-statement input are rejected.
`HARDCHARGER_ALLOW_WRITES=true` lifts that and adds `execute_statement`, annotated as destructive so
clients ask before running it.

The guard is defense in depth; the real boundary is the privileges of the Hardcharger user the
server signs in as. A sign-in token with `role: readonly` can only read (Hardcharger refuses
anything else with `permission_denied`), and under Hardcharger's access control a store user's
grants decide what each table allows.

- Credentials never appear in tool output, `server_info` or error messages: every message that
  reaches the client is redacted.
- The row cap is enforced by the server: reads run as `SELECT * FROM (<your query>) LIMIT
  max_rows + 1`, over one result stream that is closed at the cap, which stops the statement.
- The timeout is the server's (Chargewire `statementTimeoutMs`): it cancels a statement that runs too
  long, `execute_statement` included, and the error says `statement_timeout`. A client-side cancel
  a few seconds later is the backstop.
- Lost sessions: when Hardcharger evicts an idle session, the client opens a replacement with the
  same catalog and schema (also those set by `use_schema` or `USE`), says so in the log, and counts
  it in `server_info` (`session_replacements`); temporary tables and SQL-level settings of the old
  session are gone. A session an administrator killed, a closed connection or a transport failure
  reopens the connection once and retries (`reconnects`); a refused credential is never retried,
  and neither is a session ended because the sign-in was withdrawn (`token_revoked`,
  `credentials_changed`, `principal_dropped`).
- The server has no tools that touch the local filesystem or any network endpoint other than the
  configured Hardcharger servers (and, for `login_sso`, the server's sign-in routes and your
  identity provider in your browser).

## 🧯 Troubleshooting

**`speaks plain HTTP, not TLS: add ?tls=false`.** A `hardcharger://` URI uses TLS unless it says
`?tls=false`; a development server started without `--tls-cert` needs it.

**TLS errors (`self-signed certificate`, `unable to verify`, `client_transport_error`).** Set
`HARDCHARGER_TLS_ROOTS` to the CA that issued the server's certificate, or (for a throwaway server)
`HARDCHARGER_TLS_SKIP_VERIFY=true`.

**`client_transport_error` to a `10.x`, `172.16.x` or `192.168.x` address.** The extension connects
directly from your machine: connect your VPN first, then start a new chat. For a server reachable
only through SSH or Kubernetes, forward the port and use `hardcharger://localhost:31337` (with
`HARDCHARGER_TLS_SKIP_VERIFY=true` if the certificate names the internal host):

```bash
ssh -N -L 31337:hardcharger.internal:31337 bastion.example.com
kubectl port-forward svc/hardcharger 31337:31337
```

**`invalid_credentials`, `unknown_certificate_identity`, `permission_denied`.** `server_info` shows
the user and role the server signed in. Username and password must both be set; a token's issuer,
audience and e-mail must be ones the server accepts; with SSO, run `login_sso` first.

**Tools do not appear in the chat.** Open the **+** menu, choose Connectors and enable Hardcharger.
After changing settings, start a new chat.

**Logs.** Claude Desktop writes the server's stderr to
`~/Library/Logs/Claude/mcp-server-hardcharger.log` on macOS and `%APPDATA%\Claude\logs\` on Windows.

## 🛠️ Building and testing

Node 22.19 or later. For development and CI, `@gizmodata/hardcharger` and `@gizmodata/chargewire` are
built from [gizmodata/hardcharger-js](https://github.com/gizmodata/hardcharger-js) and
[gizmodata/chargewire-js](https://github.com/gizmodata/chargewire-js) at the commits pinned in
[scripts/hardcharger-js.commit](scripts/hardcharger-js.commit) and
[scripts/chargewire-js.commit](scripts/chargewire-js.commit), and packed to `.clients/`, where
`package-lock.json` finds them, so the tests run against those exact clients. `package.json`, and
so the published package, names the npm package and its range (`^2.1.0`); the tarballs are a
stand-in for development and CI only (`scripts/check-lock.mjs` checks both).

```bash
npm run clients        # clone both clients, build and pack the pinned commits
npm ci
npm run lint:ci        # eslint and the lock's shape
npm run typecheck      # src and tests
npm test               # unit tests (no server)
npm run build:mcpb     # build/hardcharger-mcp-<version>.mcpb + .sha256
docker build -t hardcharger-mcp .   # container image for the HTTP transport
helm lint charts/hardcharger-mcp    # Helm chart
```

`HARDCHARGER_MCP_CHARGEWIRE_JS_REPO` and `HARDCHARGER_MCP_HARDCHARGER_JS_REPO` point
`npm run clients` at local checkouts.

The live suites start `hardcharger-server` themselves, on free loopback ports, with a fresh
administrator password that contains `:` and `@`, an empty home directory (DuckDB's secrets
directory included), and only `PATH`, `HOME`, `TMPDIR` and the password in its environment; the MCP
server under test gets `PATH`, `HOME` and the settings each test names, never your shell's. Without
the binary they fail; they never skip, and a run in which no test passed fails too. One suite
checks a Hardcharger released before the protocol was renamed to Chargewire (the
`ghcr.io/gizmodata/hardcharger:2.2.0` image, already running, plain HTTP), named by
`HARDCHARGER_MCP_TEST_OLD_SERVER` (`host:port`, with `HARDCHARGER_MCP_TEST_OLD_SERVER_PASSWORD`);
CI starts one. Without it a full local run leaves that suite out and says so; in CI it fails.

```bash
export HARDCHARGER_MCP_TEST_SERVER_BINARY=/path/to/hardcharger-server
npm run test:live       # every tool over stdio and HTTP, OAuth sessions, every sign-in
                        # (password, token, login_sso with a throwaway identity provider,
                        # client certificates), lost sessions (eviction, KILL SESSION, restart)
npm run test:examples   # this README's examples, installed from the packed tarball, on 31337
```

Negative tests assert the error code (`invalid_credentials`, `permission_denied`,
`unknown_certificate_identity`, `statement_timeout`, `sql_error`, `client_transport_error`,
`invalid_option_value`), each beside a positive twin. CI runs everything against the image of
Hardcharger's main branch (`ghcr.io/gizmodata/hardcharger:main`), pulled with the workflow's
`GITHUB_TOKEN`; while the image is private the package must grant this repository read access
(package settings, "Manage Actions access"), or the live jobs fail. CI clones both clients
anonymously over https.

## 📦 Releasing

Releases follow [semantic versioning](https://semver.org) and [CHANGELOG.md](CHANGELOG.md): move the
`[Unreleased]` entries into a `## [X.Y.Z] - YYYY-MM-DD` section, set the same version in
`package.json`, `manifest.json` and `charts/hardcharger-mcp/Chart.yaml` (`version` and
`appVersion`), commit, and push `main` and `vX.Y.Z` together. `release.yml` runs the full CI on the
tagged commit, then makes a GitHub Release with the `.mcpb` bundles, their checksums, the Helm chart
and the npm tarball, and the CHANGELOG section as notes. Publishing to npm (public; trusted
publishing, OIDC) runs when the repository variable `NPM_PUBLISH_ENABLED` is `true`, after a check
that `@gizmodata/hardcharger` is on npm in the range `package.json` names; the image and chart go
to GHCR when `IMAGE_PUBLISH_ENABLED` is `true`. `npm publish` from a laptop refuses to run.

## 🔒 Privacy Policy

This extension runs entirely on your computer and talks only to the Hardcharger servers you
configure (and, when you use `login_sso`, that server's sign-in routes and your identity provider in
your browser).

- **Data collection.** The extension collects nothing. It sends no telemetry, analytics or crash
  reports to GizmoData or anyone else.
- **Usage and storage.** The SQL your MCP client sends and the rows the server returns pass through
  the extension in memory and are handed back to the client; nothing is written to disk. Connection
  settings are stored by Claude Desktop; credentials marked sensitive are kept in your operating
  system's keychain. An SSO access token is held in process memory only.
- **Third-party sharing.** Data is shared only with the Hardcharger server you configured. What your
  MCP client (for example Claude) does with tool results is governed by that client's own privacy
  policy.
- **Data retention.** The extension retains no data between runs. Your Hardcharger server may log
  queries according to its own configuration.
- **Contact.** Privacy questions: info@gizmodata.com. GizmoData's general privacy policy is at
  <https://gizmodata.com/privacy-policy>.

## 📄 License

[Apache License 2.0](LICENSE).

---

<p align="center">
  <a href="https://gizmodata.com"><img src="docs/assets/gizmodata-logo.png" alt="GizmoData™" width="56"></a><br>
  <sub>Built by <a href="https://gizmodata.com">GizmoData™</a></sub><br>
  <sub>Hardcharger™ and GizmoData™ are trademarks of GizmoData LLC.</sub>
</p>
