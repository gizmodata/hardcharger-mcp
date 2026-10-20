import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Binary, DateDay, Float64, Int64, Null, Table, TimestampMicrosecond, Utf8 } from "apache-arrow";

import { boundCount, convertParams, ParameterError, paramsSchema, parseIsoDateTime } from "../../dist/params.js";

describe("parseIsoDateTime", () => {
  it("parses dates and timestamps as UTC", () => {
    assert.equal(parseIsoDateTime("2024-01-02")?.toISOString(), "2024-01-02T00:00:00.000Z");
    assert.equal(parseIsoDateTime("2024-01-02T03:04:05Z")?.toISOString(), "2024-01-02T03:04:05.000Z");
    assert.equal(parseIsoDateTime("2024-01-02 03:04:05.123")?.toISOString(), "2024-01-02T03:04:05.123Z");
    assert.equal(parseIsoDateTime("2024-01-02T03:04:05.123456789")?.toISOString(), "2024-01-02T03:04:05.123Z");
    assert.equal(parseIsoDateTime("2024-01-02T03:04+02:00")?.toISOString(), "2024-01-02T01:04:00.000Z");
  });

  it("rejects non-dates", () => {
    assert.equal(parseIsoDateTime("hello"), undefined);
    assert.equal(parseIsoDateTime("2024-13-45"), undefined);
    assert.equal(parseIsoDateTime("20240102"), undefined);
    assert.equal(parseIsoDateTime("12345"), undefined);
  });
});

describe("convertParams: JSON parameters", () => {
  it("returns undefined for nothing to bind", () => {
    assert.equal(convertParams(undefined), undefined);
    assert.equal(convertParams([]), undefined);
  });

  it("passes plain values through as JSON, date-looking strings included (the server types them by use)", () => {
    assert.deepEqual(convertParams(["text", 42, 1.5, true, null, "2024-01-02"]), ["text", 42, 1.5, true, null, "2024-01-02"]);
  });

  it("supports the typed object form for what JSON carries", () => {
    assert.deepEqual(
      convertParams([
        { type: "string", value: "2024-01-02" },
        { type: "bigint", value: "9223372036854775807" },
        { type: "bigint", value: 7 },
        { type: "number", value: "1.25" },
        { type: "boolean", value: "false" },
        { type: "null" },
      ]),
      ["2024-01-02", 9223372036854775807n, 7n, 1.25, false, null],
    );
  });

  it("rejects unsafe integers, non-finite numbers and bad typed values", () => {
    assert.throws(() => convertParams([2 ** 53]), ParameterError);
    assert.throws(() => convertParams([{ type: "bigint", value: "abc" }]), ParameterError);
    assert.throws(() => convertParams([{ type: "bigint", value: 2 ** 53 }]), ParameterError);
    assert.throws(() => convertParams([{ type: "timestamp", value: "nope" }]), /not a valid ISO-8601/);
    assert.throws(() => convertParams([{ type: "boolean", value: "maybe" }]), ParameterError);
    assert.throws(() => convertParams([{ type: "binary", value: 5 }]), /base64/);
  });
});

describe("convertParams: Arrow parameters", () => {
  it("binds one Arrow row, each value with its type, when a date, timestamp or binary is given", () => {
    const out = convertParams([
      1,
      2.5,
      "a",
      null,
      { type: "date", value: "2024-01-02" },
      { type: "timestamp", value: "2024-01-02T03:04:05Z" },
      { type: "binary", value: Buffer.from([1, 2, 255]).toString("base64") },
      { type: "bigint", value: "9223372036854775807" },
    ]);
    assert.ok(out instanceof Table);
    assert.equal(out.numRows, 1);
    assert.equal(boundCount(out), 8);
    const types = out.schema.fields.map((f) => f.type);
    assert.ok(types[0] instanceof Int64);
    assert.ok(types[1] instanceof Float64);
    assert.ok(types[2] instanceof Utf8);
    assert.ok(types[3] instanceof Null);
    assert.ok(types[4] instanceof DateDay);
    assert.ok(types[5] instanceof TimestampMicrosecond);
    assert.ok(types[6] instanceof Binary);
    assert.ok(types[7] instanceof Int64);
    const cell = (i: number) => out.getChildAt(i)?.get(0);
    assert.equal(cell(0), 1n);
    assert.equal(cell(2), "a");
    assert.equal(cell(4), Date.UTC(2024, 0, 2));
    assert.equal(cell(5), Date.UTC(2024, 0, 2, 3, 4, 5));
    assert.deepEqual(Array.from(cell(6) as Uint8Array), [1, 2, 255]);
    assert.equal(cell(7), 9223372036854775807n);
    assert.deepEqual(out.schema.fields.map((f) => f.name), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("counts JSON parameters too", () => {
    assert.equal(boundCount(undefined), 0);
    assert.equal(boundCount(["a", 1]), 2);
  });
});

describe("paramsSchema", () => {
  it("accepts primitives and typed objects, rejects nested arrays", () => {
    assert.ok(paramsSchema.safeParse([1, "a", true, null, { type: "bigint", value: "1" }]).success);
    assert.equal(paramsSchema.safeParse([[1]]).success, false);
    assert.equal(paramsSchema.safeParse([{ type: "nope", value: 1 }]).success, false);
    assert.equal(paramsSchema.safeParse([{ value: 1 }]).success, false);
  });
});
