import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HardchargerError } from "@gizmodata/hardcharger";

import { describeError } from "../../dist/server.js";

describe("describeError", () => {
  it("keeps the server's message with its code, SQLSTATE and request id", () => {
    const err = new HardchargerError({
      code: "sql_error",
      status: 400,
      message:
        "Catalog Error: Table with name nope does not exist! (sql_error, SQLSTATE 42P01, HTTP 400, request r_abc)",
    } as ConstructorParameters<typeof HardchargerError>[0]);
    assert.equal(
      describeError(err, (t) => t),
      "Catalog Error: Table with name nope does not exist! (sql_error, SQLSTATE 42P01, HTTP 400, request r_abc)",
    );
  });

  it("drops the client's [hardcharger] prefix and redacts", () => {
    const err = new HardchargerError({
      code: "client_invalid_argument",
      message: "[hardcharger] invalid url hardcharger://h: password is hunter2",
    } as ConstructorParameters<typeof HardchargerError>[0]);
    assert.equal(describeError(err, (t) => t.replace("hunter2", "***")), "invalid url hardcharger://h: password is *** (client_invalid_argument)");
    assert.equal(describeError("plain", (t) => t), "plain");
  });

  it("adds the code to a client error whose message lacks it (no HTTP answer)", () => {
    const err = new HardchargerError({
      code: "client_transport_error",
      message: "GET : fetch failed: self-signed certificate in certificate chain (SELF_SIGNED_CERT_IN_CHAIN)",
    } as ConstructorParameters<typeof HardchargerError>[0]);
    assert.match(describeError(err, (t) => t), /\(SELF_SIGNED_CERT_IN_CHAIN\) \(client_transport_error\)$/);
    // ... and to the plain-HTTP hint, which wraps it.
    const wrapped = new Error("hint: add ?tls=false", { cause: err });
    assert.equal(describeError(wrapped, (t) => t), "hint: add ?tls=false (client_transport_error)");
  });
});
