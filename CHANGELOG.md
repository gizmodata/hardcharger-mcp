# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.1] - 2026-11-07

### Added
- Connecting to a GizmoData Cloud cluster that is stopped (auto-resume) no longer starts it: the
  client connects lazily when the server's stand-in says it is stopped, and signs in at the first
  query or statement (from `@gizmodata/hardcharger` 2.4.2 on `@gizmodata/chargewire` 2.3.3).
  This server's own connection setup (the default catalog and schema, the server-settings probe)
  then runs at that first query, before it; a wrong password or an unreachable server is that
  query's error, not a warning about the default catalog.

### Fixed
- Listing and describing never sign in to a server or open a session there, so they never start a
  GizmoData Cloud cluster that was stopped while idle (auto-resume): only a query or statement
  against a server may. `server_info` reports a connection not used yet from its configuration
  (versions and user say "not connected yet"; it used to connect to read them), and the table
  resource list covers only connections already in use, with or without a broker (it used to sign
  in to every configured server). `list_connections` asks only the broker, as before.
- Closing a person's idle session (after `HARDCHARGER_MCP_SESSION_IDLE_SECONDS`), and closing a
  connection, no longer signs in first when the token is close to expiring (from
  `@gizmodata/hardcharger` 2.4.2 on `@gizmodata/chargewire` 2.3.3, whose cancels, `transaction()`
  clean-up and progress polls never sign in either). Before, an idle eviction late in a token's
  life sent a sign-in that woke the stopped cluster for nobody.

### Changed
- Built on `@gizmodata/hardcharger` 2.4.2 (hardcharger-js `372c798`) and `@gizmodata/chargewire`
  2.3.3 (chargewire-js `ca7940a`); the dependency range is `^2.4.2`.

## [2.4.0] - 2026-11-05

### Added
- A `hardcharger://` URI with no port and a GizmoData Cloud host (`gizmodata.com` or a name under it,
  in any case, a trailing dot allowed) connects to port 443, where GizmoData Cloud clusters answer,
  instead of 31337 (from `@gizmodata/hardcharger` 2.3.0). Look-alikes such as `evilgizmodata.com` and
  `gizmodata.com.example.org` keep 31337, and an explicit port always wins. The README, the Claude
  Desktop extension's URI help and the Helm values say so.

### Fixed
- After SQL that changes the session's settings (a statement whose first word is `SET`, `RESET` or
  `PRAGMA`), a lost connection is no longer reopened and the call retried: the new session doesn't
  have the settings, so the statement ran with others, without an error. The call now fails with an
  error that says the settings are gone and the statement did not run again (`SettingsLostError`);
  the next call runs on a new session. With `@gizmodata/chargewire` 2.2.1 the client refuses the same
  re-run on a session it replaced itself (an idle eviction), where this layer never saw an error.
- A `USE` through `run_query` pinned the catalog and schema it read from the session document, which
  a server before Chargewire 2.2.1 (Hardcharger 2.7.0) can answer before it has recorded the USE, so
  the pin could set the old schema back. They are now read from the engine (`current_database()`,
  `current_schema()`); `use_schema` takes them from the answer to its own options request.

### Changed
- Built on `@gizmodata/hardcharger` 2.3.0 and `@gizmodata/chargewire` 2.2.1 (the dependency range is
  now `^2.3.0`).

## [2.3.0] - 2026-11-05

### Added
- `HARDCHARGER_RESUME_TIMEOUT_SECONDS` (default `600`; `resume_timeout_seconds` in the Claude Desktop
  extension, in the Helm chart's values): how long the client waits for a stopped server that is
  starting again (`server_resuming`, a GizmoData Cloud cluster with auto-resume) before reporting it.
  Each wait is logged to stderr, and a call whose query timeout runs out while the server is still
  resuming fails with a message that says so ("try again in a minute") instead of a query timeout.
  `server_info` reports `resume_timeout_seconds`.

### Changed
- Built on `@gizmodata/hardcharger` 2.2.0 and `@gizmodata/chargewire` 2.2.0 (the dependency range is
  now `^2.2.0`): `resumeTimeout` and `onResuming`, `idle_in_transaction` in `SessionEndedReason`, and
  the client's own rule for lost sessions (Chargewire §5.7).

### Fixed
- With writes enabled, a lost connection (an administrator's `KILL SESSION`, a server restart, a
  lost session) after `BEGIN` was reopened and the statement retried on the new session, where it ran
  alone in autocommit and committed while the transaction's earlier statements had been rolled back.
  Once SQL that can begin a transaction (`BEGIN`, `START TRANSACTION`, anything naming autocommit) has
  run on a connection, a lost connection is no longer retried: the call fails with an error that says
  the transaction was rolled back and the statement did not run again, and the next call runs on a new
  session. A metadata call that finds such a loss fails the same way. Without such SQL, a lost
  connection is still reopened once and the call retried.

## [2.2.1] - 2026-11-04

### Changed
- Built on `@gizmodata/hardcharger` 2.1.1 and `@gizmodata/chargewire` 2.1.0 (the dependency range is
  now `^2.1.1`). A query that returns no rows with a LIST column no longer fails when the client
  sets its unread result aside ([gizmodata/hardcharger#23](https://github.com/gizmodata/hardcharger/issues/23)),
  and a session Hardcharger 2.7.0 ends for an idle transaction is replaced by the client.
- `server_info` reports the server's `hardcharger.idle_in_transaction_session_timeout` among its settings.

### Fixed
- With writes enabled, a statement that found its transaction ended for sitting idle past the server's
  `idle_in_transaction_session_timeout` (`session_ended`, reason `idle_in_transaction`, Hardcharger
  2.7.0) was retried on a new connection, where it ran in autocommit and committed on its own while
  the transaction's earlier statements had been rolled back. It now fails with that error and is not
  retried; the next statement runs on the new session. A live test covers it, beside a busy
  transaction that commits.

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
