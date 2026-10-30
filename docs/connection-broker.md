# Connection broker protocol

With `HARDCHARGER_MCP_BROKER_URL`, the MCP server holds no Hardcharger credentials. A *connection
broker*, usually the control plane that runs the Hardcharger servers, answers two questions for each
signed-in person: which servers may they reach, and a sign-in token for one of them. The person's
statements then run as that person, under the server's access control (grants, row policies,
masking), and the server's audit log names them.

This page is the contract a broker implements. `test/live/broker.test.ts` runs a reference
implementation of it against a real `hardcharger-server`.

## Trust

- **The MCP server** is an OAuth resource server (`HARDCHARGER_MCP_OAUTH_ISSUER`): every MCP request
  carries the person's access token, which it verifies (issuer, audience, signature, expiry).
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

Both are `POST` with a JSON body, under `HARDCHARGER_MCP_BROKER_URL`:

```http
POST <broker>/connections
POST <broker>/connections/<id>/token
Authorization: Bearer <HARDCHARGER_MCP_BROKER_TOKEN>
Content-Type: application/json

{"subject_token": "<the person's OAuth access token>",
 "subject_token_type": "urn:ietf:params:oauth:token-type:access_token"}
```

`<id>` is URL-encoded.

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
      "allow_writes": false
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

Entries that don't fit are skipped (and logged). The list is reused for
`HARDCHARGER_MCP_BROKER_CACHE_SECONDS` (default 60) and asked for again at once by
`list_connections`. A server the broker stops listing is closed for that person.

`allow_writes` decides whether the MCP server offers writes at all. Under the server's access
control, what a person may change is still decided by their grants: a broker can set
`allow_writes` true on such a server and let the grants decide.

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
