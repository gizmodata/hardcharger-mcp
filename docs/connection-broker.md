# Connection broker protocol

With `HARDCHARGER_MCP_BROKER_URL`, the MCP server holds no Hardcharger credentials. A *connection
broker*, usually the control plane that runs the Hardcharger servers, answers two questions for each
signed-in person: which servers may they reach, and a sign-in token for one of them. The person's
statements then run as that person, under the server's access control (grants, row policies,
masking), and the server's audit log names them.

This page is the contract a broker implements. `test/live/broker.test.ts` runs a reference
implementation of it against a real `hardcharger-server`.

## Trust

- **The MCP server** is an OAuth resource server (`HARDCHARGER_MCP_OAUTH_ISSUER`, which its metadata
  names as the authorization server): every MCP request carries the person's access token, which
  it has the broker check (`/introspect`).
- **The broker** authenticates the MCP server by its own credential (`HARDCHARGER_MCP_BROKER_TOKEN`,
  sent as `Authorization: Bearer`) and receives the person's access token as an
  [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693) subject token. It verifies that token itself
  and decides who the person is. The access token is never the broker credential: MCP forbids
  passing a client's token through to another API, and a token minted for the MCP server
  (`aud` = its public URL) should not open the broker's general API.
- **The Hardcharger server** trusts the broker's signing key (`--token-signature-verify-cert-path`
  or a JWKS) for the token_exchange grant. With access control on and
  `--token-auto-provision-users`, a person's first sign-in creates their store user with no grants.

The broker alone decides what a person may reach. The MCP server only lists what the broker lists
and asks for tokens for those.

## Requests

All three are `POST` with a JSON body, under `HARDCHARGER_MCP_BROKER_URL`:

```http
POST <broker>/introspect
POST <broker>/connections
POST <broker>/connections/<id>/token
Authorization: Bearer <HARDCHARGER_MCP_BROKER_TOKEN>
Content-Type: application/json

{"subject_token": "<the person's OAuth access token>",
 "subject_token_type": "urn:ietf:params:oauth:token-type:access_token"}
```

`<id>` is URL-encoded.

### `POST /introspect`

Whether the person's access token is active, and whose it is. In broker mode the MCP server checks
every request's bearer token here instead of verifying it as a JWT, so providers whose access tokens
are opaque (Clerk's, unless the instance has JWT access tokens on) work, and the MCP server needs no
keys or credentials of the provider. An active answer is reused for 60 seconds for the same token.

```json
{"active": true, "sub": "user_2abc…", "email": "ann@example.com", "name": "Ann Example"}
```

`{"active": false}` (still HTTP 200) for a token the broker doesn't accept: the MCP server answers
401 and the client signs the person in again. Any error status means the broker couldn't say: the
MCP server answers 503, not 401, so a broker outage doesn't send everyone back to sign in. Answer
active for any valid sign-in, even one that may reach nothing: the connection list explains that
better than a sign-in loop does.

### `POST /connections`

The servers this person may reach now:

```json
{
  "connections": [
    {
      "id": "6f1d…",
      "name": "analytics-prod",
      "label": "Acme / Analytics / prod",
      "uri": "hardcharger://analytics-prod.example.com",
      "default_catalog": "lake",
      "default_schema": "main",
      "allow_writes": false,
      "read_only": true
    }
  ],
  "message": "Shown when the list is empty, e.g. how to create a server."
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | The broker's id; used in the token request |
| `name` | yes | What the person (and the model) calls it: 1-64 letters, digits, `.`, `_`, `-`, unique for this person (case-insensitive) |
| `label` | no | A longer description shown by `list_connections` |
| `uri` | yes | `hardcharger://host[:port][?tls=false]` |
| `default_catalog`, `default_schema` | no | The session's search path at start |
| `allow_writes` | no (false) | Whether this person may write through the MCP server here; writes also need `HARDCHARGER_ALLOW_WRITES=true` on the MCP server |
| `read_only` | no (null) | `true`: require a server-enforced read-only session on this connection (see [Read-only sessions](#read-only-sessions)). Absent or `null`: the MCP server's `HARDCHARGER_READ_ONLY`. `false`: the same as absent; it never lifts `HARDCHARGER_READ_ONLY=true` |

Entries that don't fit are skipped (and logged). The list is reused for
`HARDCHARGER_MCP_BROKER_CACHE_SECONDS` (default 60) and asked for again at once by
`list_connections`. A server the broker stops listing is closed for that person.

When the list can't be had, what happens depends on why:

- **A refusal** (any 4xx except 408 and 429, e.g. a 403 for a suspended account): the person
  reaches nothing from then on; their open sessions are closed, and the broker's text is the
  answer to every call until a list succeeds.
- **No answer** (unreachable, a timeout, 408, 429, a 5xx, or a body that isn't a connection list):
  the last list stays in use only while it is younger than `HARDCHARGER_MCP_BROKER_CACHE_SECONDS`.
  Once it is that old and can't be renewed, its connections are closed and every call answers
  with the problem ("The connection broker is unreachable; try again shortly.") until the broker
  lists again. So no setting a list carried (`read_only`, `allow_writes`, access itself) outlives
  the cache period.

`allow_writes` decides whether the MCP server offers writes at all. Under the server's access
control, what a person may change is still decided by their grants: a broker can set
`allow_writes` true on such a server and let the grants decide.

#### Read-only sessions

`read_only: true` makes the Hardcharger server itself refuse writes on that person's session
(Chargewire session option `read_only`, capability `read_only_sessions`, Hardcharger 2.13.0 and
later), not only the MCP server's own SQL check. The MCP server then treats the connection
exactly as one configured with `HARDCHARGER_READ_ONLY`: it requests `read_only` when it creates
the session, confirms the server granted it before any setup query or tool query, requests it
again on every reconnect or replacement session, and offers no writes there whatever
`allow_writes` says. A server older than 2.13.0 refuses such a session (`read_only: unknown
session option`, code `unknown_option`), and one that opens it without confirming `read_only`
fails with "The server did not confirm read_only=true"; either way every call on that connection
fails and nothing runs there. So set `read_only` only for servers that support it, and leave it
absent for older ones.

The connection is read-only when **either** the MCP server's `HARDCHARGER_READ_ONLY` is `true`
**or** the broker says `read_only: true`. `HARDCHARGER_READ_ONLY=true` is the operator's floor:
a broker's `false` doesn't lift it. A broker that never sends the field (older brokers) gets the
MCP server's setting, as before.

A session's read-only state can't change. When a later list changes a connection's `read_only`
(for instance an administrator turned AI writes off, or on again), the MCP server closes that
person's session on the server and opens a new one with the new setting at the next call:

- A call still under way on the old connection, including one still connecting (a stopped server
  resuming), fails with "was closed while this call waited or ran" and is not run again; a session
  that finishes opening after the change is closed at once, never used.
- On the same server (same `id` and `uri`), the catalog and schema the person chose (`use_schema`,
  `USE`) carry over to the new session; without such a choice the list's `default_catalog` and
  `default_schema` apply.
- When SQL that can begin a transaction (`BEGIN`, ...) without a `COMMIT` or `ROLLBACK` after it, or
  SQL that changes session settings (`SET`, `RESET`, `PRAGMA`), ran on the old session, the first
  statement on the new one fails with the same error as after a lost session and is not run: the
  old transaction was rolled back, and on the new session the statement would run alone, in
  autocommit. This also holds when the connection was replaced twice before that statement, and
  when it was missing from one list and listed again.

A change takes effect when the MCP server next asks for the list: within
`HARDCHARGER_MCP_BROKER_CACHE_SECONDS` (also when the broker can't answer then, see above), or at
once on `list_connections`. A change to `allow_writes` or `label` alone keeps the session.

### `POST /connections/<id>/token`

A sign-in token for this person on that server:

```json
{"token": "<signed JWT>", "expires_in": 600}
```

The token is a JWT the server accepts for the token_exchange grant: `iss` and `aud` as the server
is configured, the person in `email` or `sub` (the server's user name, matched exactly: keep
the case the store uses), a `role` (`user` or `readonly`; under access control `user` lets grants
decide, and a store user first provisioned from a `readonly` token stays read-only), and
optionally the groups claim for `CREATE GROUP MAPPING`. Keep it short-lived: the MCP server asks
again whenever the client signs in, reusing a token for at most 80% of `expires_in`.

The Hardcharger server's own access token, issued in exchange, lasts `--token-lifetime-seconds`
(24 hours by default), not the subject token's lifetime. The MCP server closes a person's
session on a server once the broker stops listing it; set a shorter server token lifetime if
anything else holds such tokens.

## Errors

Any non-2xx status is an error. The MCP server shows the person the broker's own text from a JSON
body's `error_description`, `message` or string `detail` (FastAPI's shape), so write it for them:
"You no longer have access to analytics-prod." A `401` without text is reported as "reconnect the
connector, or ask the administrator to check this server's broker credential".

| Status | When |
|---|---|
| 401 | The MCP server's credential, or the subject token, is not accepted |
| 403 | The person may not reach this server (any more) |
| 404 | No such server |
| 409 | The server can't take sign-ins now (e.g. stopped); say how to start it |
