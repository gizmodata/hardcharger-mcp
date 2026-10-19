# Implementation notes

What differs from gizmosql-mcp under the hood, and known limitations. Verified against
`@gizmodata/hardcharger` 0.1.0 (hardcharger-js `eb17542`, warp-sql-js `0a91935`),
`@modelcontextprotocol/sdk` 1.32.1, `@anthropic-ai/mcpb` 2.1.2 and `hardcharger-server` 0.3.0.

## Client and protocol

- The client is pure JavaScript over HTTP(S) (Warp SQL), so the `.mcpb` bundle has no native
  driver, no per-platform prebuilds and no install scripts; `build-mcpb.sh` refuses a bundle with
  native code in it. Claude Desktop runs extensions under Electron's `utilityProcess` (Node 24.18
  in 1.44121.4), which meets the client's Node 22.19 floor. Not yet verified: a manual install of
  the bundle in Claude Desktop on each platform before the first release.
- Lost sessions: GizmoSQL silently recreated an evicted session (same bearer token, server
  defaults), so gizmosql-mcp re-applied `USE` and the query timeout on a timer derived from
  `gizmosql_settings()`. Warp SQL answers `session_not_found`; the client opens a replacement and
  replays the session options it set (catalog, schema). So the search path is set as session
  options (`setOptions`), and after `use_schema` or a `USE` the effective catalog and schema are
  read back from the session document and set again, so the replay carries them. Eviction is not
  instant: with `--session-idle-timeout 3` a session survived 5 s and was gone after 12 s.
- `session_ended` (an administrator's `KILL SESSION`, reason `killed`) is not replaced by the
  client (it ends the sign-in too), so the MCP layer reopens the connection once and retries, as
  gizmosql-mcp did for "session has been killed". A server restart is handled by the client
  alone: the old access token is refused, it signs in again with the password, then replaces the
  session. A session ended because the sign-in was withdrawn (reason `token_revoked`,
  `credentials_changed` or `principal_dropped`, Warp SQL §4.2 and §5.6) is never reopened: the
  error, with its reason, is the answer. An expired token, no reason or a reason this version
  doesn't know reopens as `killed` does.
- `hardcharger_sessions()` reports a UUID per session, not the Warp SQL session id the client
  sees; `KILL SESSION` takes the former (`HARDCHARGER_CURRENT_SESSION()`).
- Timeouts: `statementTimeoutMs` (§6.9) per statement; the server cancels and answers
  `statement_timeout`. The client-side `AbortSignal` (5 s later) cancels by statement id. Unlike
  the ADBC driver manager under gizmosql-mcp, DML through `execute_statement` is cancellable too.
- JSON parameters are typed by the server from their use (a date string compared with a DATE
  column binds as a date); `SELECT ?` gets VARCHAR. Arrow parameters need a prepared statement
  (§7.2). Hardcharger 0.3.0 reports a placeholder nothing types (`SELECT ?`) as `Null` in the
  parameter schema, so the Arrow row carries its own types rather than converting to the server's.
- A capped read uses one result partition (`resultPartitions: 1`): splitting a result into eight
  parallel streams buys nothing for at most `max_rows + 1` rows, and one stream stops cleanly when
  closed at the cap.
- Errors answered by the server end with `(code, SQLSTATE, HTTP status, request id)`; errors raised
  before an answer (`client_transport_error`, `client_invalid_argument`) don't name their code, so
  `describeError` appends it.
- Observed with Hardcharger 0.3.0: a password sign-in that presents no client certificate to a
  server started with `--mtls-ca-cert` had its connection closed ("other side closed",
  `UND_ERR_SOCKET`); the README example runner presents the certificate when it checks that
  server. Not investigated further.

## Browser sign-in

`login_sso` runs the flow of `hardcharger --auth-type external`: `GET /oauth/initiate`, open
`auth_url`, poll `/oauth/token/<uuid>` (a 404 means expired or already used), then sign in with
the ID token as the `token_exchange` grant. The base URL is the CLI's: `http(s)://<host>:<oauth
port>` (https when the URI uses TLS), or `HARDCHARGER_OAUTH_BASE_URL`. The live test drives it with
a throwaway OIDC provider and a `HARDCHARGER_BROWSER` script that follows the redirects.

## MCP SDK / MCPB details (unchanged from gizmosql-mcp)

- The SDK stamps `$schema: draft-07` on every tool schema (typescript-sdk #2721); strict hosts
  reject it. `jsonSchema2020()` in `server.ts` overrides the stamp; `schema-dialect.test.ts` guards
  it.
- Tool names use underscores only (Claude Desktop rejects dots).
- `npx -y @gizmodata/hardcharger-mcp` from inside this checkout resolves to the local project and
  fails with "command not found"; use `node /path/to/dist/cli.js` for a local-testing entry.
