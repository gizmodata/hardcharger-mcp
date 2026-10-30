# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.2.0] - 2026-10-30

### Added
- Per-person credentials through a connection broker (`HARDCHARGER_MCP_BROKER_URL`,
  `HARDCHARGER_MCP_BROKER_TOKEN`, HTTP transport with OAuth). The server then holds no Hardcharger
  credentials: a broker, such as the control plane that runs the servers, lists the servers each
  signed-in person may reach and mints them short-lived sign-in tokens, which the client exchanges
  (token_exchange). Every statement runs as that person, under the server's grants, row policies and
  masking. The person's token is presented to the broker as an RFC 8693 subject token, never as its
  credential. The broker also checks each request's access token (`/introspect`, answers reused for 60 s), so
  opaque access tokens such as Clerk's work and this server needs no provider keys; a broker outage answers 503,
  not 401. Writes need the broker's per-server `allow_writes` as well as `HARDCHARGER_ALLOW_WRITES`.
  Protocol: `docs/connection-broker.md`.
- `list_connections` and `server_info` report whether each connection accepts writes
  (`allow_writes`), and a brokered connection's description.

### Fixed
- The README said Clerk issues JWT access tokens by default; it issues opaque ones unless the instance turns JWT
  access tokens on.

## [2.1.0] - 2026-10-29

### Changed
- Built on the Chargewire protocol and clients: `@gizmodata/hardcharger` 2.1.0, on
  `@gizmodata/chargewire` 2.0.0. `server_info` reports
  the protocol as `chargewire 1`. Tool names, settings and connection URIs are unchanged.
- Still works with Hardcharger servers released before the rename (2.2.0 and earlier): the
  client falls back to them on its own, and `HARDCHARGER_URI` values written for earlier
  versions keep working.

## [2.0.0] - 2026-10-20

The first published release, with Hardcharger 2.0.0 (0.1.0 was never published). The Changed and
Fixed entries describe what moved since 0.1.0, for anyone who installed it from git.
<!-- Set the date above at tag time. -->

### Changed
- Built on `@gizmodata/hardcharger` 2.0.0 (hardcharger-js `a6e93a2`, on `@gizmodata/chargewire` 1.0.0,
  chargewire-js `903feb4`), the clients for Chargewire protocol 1.0.0 with browser sign-in (were
  `a4ac97c` and `6dea14c`). The chart, the extension manifest and the npm package are 2.0.0: the
  Hardcharger clients and integrations launch with the server's version.
- **Breaking:** `login_sso` runs Chargewire browser sign-in (§4.3) on the connection's own URI and
  port, through `@gizmodata/hardcharger`, as Hardcharger now offers it (its separate OAuth port and
  `/oauth/initiate` routes are gone). It signs in with the access token the server hands out, used
  as is (call `login_sso` again when it expires), instead of exchanging an ID token. A failed
  sign-in reports the flow's code (`access_denied`, `identity_provider_error`,
  `invalid_credentials`); an expired or collected flow (`flow_not_found`) starts over on the next
  call; a server without browser sign-in (`not_implemented`) is reported as unavailable.
  `HARDCHARGER_OAUTH_PORT`, `HARDCHARGER_OAUTH_BASE_URL` and the extension's "SSO port" setting
  are removed.
- The client's own error codes begin with `client_`: a lost connection is reopened on
  `client_transport_error` and `client_connection_closed` (was `transport_error`,
  `connection_closed`), the plain-HTTP hint keys on `client_transport_error`, and error messages
  name the new codes (e.g. `(client_transport_error)`, `(client_invalid_argument)`).
- `server_info` on a Chargewire server other than Hardcharger reads the DuckDB version from the
  server-info key `duckdb_version` (was `engine_version`, which protocol 1.0.0 dropped).
- A session ended with reason `token_revoked`, `credentials_changed` or `principal_dropped` is no
  longer reopened with the configured credentials (Chargewire §4.2, §5.6): the error, with its
  reason, is returned. `killed`, `token_expired`, no reason or an unknown reason still reopen once.

### Added
- Production dependency license texts travel with the desktop extension as
  `THIRD_PARTY_NOTICES.txt` and with the image under `/usr/share/doc/hardcharger-mcp/`.
- Tests: reopening after `client_transport_error`; no reopen after a session ended for a revoked
  token; `isConnectionLost` for every `session_ended` reason and for the old unprefixed codes.
- Tests for `login_sso` on browser sign-in: unit tests for each poll answer (pending at the
  server's interval, complete, a failed flow's code, `flow_not_found`, an expired flow, a server
  without browser sign-in, an unreachable one); the live tests run it against
  `hardcharger-server --oauth-client-id` on its main port.

### Fixed
- CI's live tests on main failed: the browser sign-in suite started `hardcharger-server` with
  `--oauth-port`, which Hardcharger 2.0.0-rc.1 removed (browser sign-in runs on the server's own
  port, Chargewire §4.3), so the server exited with "unknown option". The suite now passes
  `--oauth-base-url` with the server's port (from the merged Chargewire 1.0 work).

### Documentation

- The README banner is the new Hardcharger™ logo, the bull mascot lockup in a light and a dark
  version that follows the reader's color scheme, in place of the GizmoData banner card, and the
  Claude Desktop extension's icon (`icon.png`, 512 px) is the Hardcharger bull head in place of the
  GizmoData logo.

## [0.1.0] - 2026-10-19

The Hardcharger™ port of [gizmosql-mcp](https://github.com/gizmodata/gizmosql-mcp) 0.4.11: the same
tools, resource, transports, OAuth resource-server mode, per-user HTTP sessions, Claude Desktop
extension, container image and Helm chart, on Hardcharger's Chargewire protocol through
`@gizmodata/hardcharger` (hardcharger-js `a4ac97c` on chargewire-js `6dea14c`).

### Added
- Tools `list_connections`, `use_connection`, `list_catalogs`, `list_schemas`, `list_tables`,
  `describe_table`, `use_schema`, `run_query`, `explain_query`, `server_info`, `execute_statement`
  (only with `HARDCHARGER_ALLOW_WRITES=true`) and `login_sso` (only with
  `HARDCHARGER_ENABLE_SSO=true`, stdio only), and the table DDL resource
  `hardcharger://{connection}/schema/{catalog}/{schema}/{table}`.
- Connections are `hardcharger://host[:port][/prefix][?tls=false]` URIs (`HARDCHARGER_URI`, TLS to
  port 31337 unless the URI says otherwise), checked the way the client reads them before anything
  is sent. Only `HARDCHARGER_*` settings are read.
- Sign-in with a password, a signed sign-in token (`HARDCHARGER_TOKEN`, the `token_exchange`
  grant; the token also works as the password of user `token`), a client certificate
  (`HARDCHARGER_MTLS_CERT` + `HARDCHARGER_MTLS_KEY`: alone, the certificate is the credential), or
  the server's browser sign-in (`login_sso`, the same OAuth routes as `hardcharger --auth-type
  external`; `HARDCHARGER_BROWSER` names the browser). `HARDCHARGER_TLS_ROOTS` trusts a private CA.
- Query timeouts are the server's own (`statementTimeoutMs`, Chargewire §6.9): a runaway statement is
  cancelled on the server and reported as `statement_timeout`, with a client-side cancel a few
  seconds later as backstop. This covers `execute_statement` too.
- Lost sessions: the client replaces a session the server evicted and replays its catalog and
  schema, including ones set by `use_schema` or a `USE` run through `run_query`; a session an
  administrator killed, a closed connection or a transport failure reopens the connection once.
  `server_info` reports `session_replacements` and `reconnects`.
- Errors keep the server's message with its Chargewire code, SQLSTATE, HTTP status and request id
  (`... (sql_error, SQLSTATE 42P01, HTTP 400, request r_...)`); errors raised before an answer get
  their code added (`(transport_error)`), and a TLS handshake against a plain-HTTP server says to
  add `?tls=false`.
- `server_info` reports `HARDCHARGER_VERSION()`, `HARDCHARGER_USER()`, `HARDCHARGER_ROLE()`, the
  protocol and capabilities from discovery, the server's idle timeout from the session document,
  and settings from `hardcharger_settings()`.
- Bind parameters travel as Chargewire JSON parameters; a date, timestamp or binary parameter binds
  the row as Arrow data through a prepared statement.
- Claude Desktop extension (`.mcpb`): one all-JavaScript bundle for every platform (no native
  driver), with URI, token, client certificate and CA settings.
- Live tests against `hardcharger-server` (every tool, the HTTP transport, every sign-in, lost
  sessions); they fail, never skip, without a server. CI runs them against
  `ghcr.io/gizmodata/hardcharger:main`; the release workflow runs the full CI on the tagged commit
  first.

### Changed (from gizmosql-mcp)
- Plain ISO-8601 strings in `params` are no longer turned into timestamps: the server types each
  JSON parameter from where it is used (a date string compared with a DATE column is a date). Use
  `{"type": "date"|"timestamp", ...}` where nothing gives the type.

### Removed (from gizmosql-mcp)
- The native ADBC driver and everything around it (bundled drivers per platform,
  `GIZMOSQL_DRIVER_LIB`, the install-script approval): the client is pure JavaScript.
- The timed session refresh (`GIZMOSQL_SESSION_REFRESH_SECONDS`): GizmoSQL silently recreated an
  evicted session, so the search path had to be re-applied on a timer; Chargewire reports the loss
  and the client replays the session's options.
- Host/port/plaintext settings (`GIZMOSQL_HOST`, `_PORT`, `_PLAINTEXT`): the URI says all three.
- Flight SQL error unwrapping and the SqlInfo fallback, which have no Chargewire counterpart.
