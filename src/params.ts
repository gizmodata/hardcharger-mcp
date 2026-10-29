// Conversion of JSON tool arguments into the values the Hardcharger client binds to
// `?` / `$1` placeholders.
//
// Plain JSON values travel as Chargewire JSON parameters (§6.1): string, number, boolean
// and null as they are. The server types each one from where it is used, so a date
// string compared with a DATE column, or inserted into a TIMESTAMP one, is read as a
// date. A typed object form `{ "type": "...", "value": ... }` covers what that cannot
// express: a bigint beyond JavaScript's safe integers (sent exactly), and dates,
// timestamps and binary values whose type the SQL does not give. When any parameter is
// a date, timestamp or binary value, all of them are bound as one row of Arrow data
// (the statement is prepared first), each with its own Arrow type.

import type { JsonScalar } from "@gizmodata/hardcharger";
import {
  Binary,
  Bool,
  type DataType,
  DateDay,
  Field,
  Float64,
  Int64,
  Null,
  RecordBatch,
  Schema,
  Struct,
  Table,
  TimestampMicrosecond,
  Utf8,
  makeData,
  vectorFromArray,
} from "apache-arrow";
import { z } from "zod";

export const TYPED_PARAM_TYPES = [
  "string",
  "number",
  "bigint",
  "boolean",
  "date",
  "timestamp",
  "binary",
  "null",
] as const;

export type TypedParamType = (typeof TYPED_PARAM_TYPES)[number];

export const typedParamSchema = z
  .object({
    type: z.enum(TYPED_PARAM_TYPES),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  })
  .strict();

export const paramValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  typedParamSchema,
]);

export const paramsSchema = z.array(paramValueSchema);

export type JsonParamValue = z.infer<typeof paramValueSchema>;

/** What a statement is bound with: JSON values, or one row of Arrow data. */
export type BoundParams = JsonScalar[] | Table;

export class ParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParameterError";
  }
}

// YYYY-MM-DD
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
// YYYY-MM-DD[T ]HH:MM[:SS[.fraction]][Z|±HH[:MM]]
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/u;

/** Parses an ISO-8601 date or timestamp string into a Date (UTC when no zone given). */
export function parseIsoDateTime(text: string): Date | undefined {
  if (ISO_DATE.test(text)) {
    const d = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (ISO_TIMESTAMP.test(text)) {
    let normalized = text.replace(" ", "T");
    // Treat zone-less timestamps as UTC so the bound value is deterministic.
    if (!/(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(normalized)) normalized += "Z";
    // Trim fractions beyond milliseconds (Date only keeps ms).
    normalized = normalized.replace(/(\.\d{3})\d+/u, "$1");
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

/** One converted parameter: its value and, for the Arrow form, its type. */
interface Converted {
  value: JsonScalar | Date | Uint8Array;
  /** Set for values JSON cannot type: these force the Arrow form. */
  arrowType?: DataType;
}

function convertTyped(index: number, type: TypedParamType, value: unknown): Converted {
  const where = `parameter ${index + 1} (type "${type}")`;
  switch (type) {
    case "null":
      return { value: null };
    case "string":
      if (value === null || value === undefined) return { value: null };
      return { value: String(value) };
    case "boolean":
      if (typeof value === "boolean") return { value };
      if (value === "true") return { value: true };
      if (value === "false") return { value: false };
      throw new ParameterError(`${where}: expected a boolean value.`);
    case "number":
      if (typeof value === "number") return { value };
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return { value: Number(value) };
      }
      throw new ParameterError(`${where}: expected a numeric value.`);
    case "bigint": {
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) {
          throw new ParameterError(
            `${where}: ${value} is not a safe integer; pass the value as a decimal string.`,
          );
        }
        return { value: BigInt(value) };
      }
      if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
        return { value: BigInt(value.trim()) };
      }
      throw new ParameterError(`${where}: expected an integer or a decimal-digit string.`);
    }
    case "date":
    case "timestamp": {
      let d: Date;
      if (typeof value === "number") d = new Date(value);
      else if (typeof value === "string") d = parseIsoDateTime(value) ?? new Date(value);
      else throw new ParameterError(`${where}: expected an ISO-8601 string or epoch milliseconds.`);
      if (Number.isNaN(d.getTime())) {
        throw new ParameterError(`${where}: "${String(value)}" is not a valid ISO-8601 date/timestamp.`);
      }
      return { value: d, arrowType: type === "date" ? new DateDay() : new TimestampMicrosecond() };
    }
    case "binary": {
      if (typeof value !== "string") {
        throw new ParameterError(`${where}: expected a base64 string.`);
      }
      return { value: new Uint8Array(Buffer.from(value, "base64")), arrowType: new Binary() };
    }
    default:
      throw new ParameterError(`${where}: unsupported parameter type.`);
  }
}

function convertOne(index: number, value: JsonParamValue): Converted {
  if (value === null) return { value: null };
  if (typeof value === "boolean" || typeof value === "string") return { value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ParameterError(`parameter ${index + 1}: ${value} is not a finite number.`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new ParameterError(
        `parameter ${index + 1}: ${value} exceeds JavaScript's safe integer range; ` +
          `pass it as {"type":"bigint","value":"<digits>"}.`,
      );
    }
    return { value };
  }
  if (typeof value === "object" && value !== null && "type" in value) {
    return convertTyped(index, value.type, value.value);
  }
  throw new ParameterError(`parameter ${index + 1}: unsupported value.`);
}

/** The Arrow type for a value that JSON would have carried. */
function inferredType(value: Converted["value"]): DataType {
  if (value === null) return new Null();
  if (typeof value === "boolean") return new Bool();
  if (typeof value === "bigint") return new Int64();
  if (typeof value === "number") return Number.isInteger(value) ? new Int64() : new Float64();
  return new Utf8();
}

/** One row of Arrow parameters, a column per placeholder (named 1, 2, ...). */
function arrowRow(converted: Converted[]): Table {
  const fields: Field[] = [];
  const children = converted.map((c, i) => {
    const type = c.arrowType ?? inferredType(c.value);
    let value: unknown = c.value;
    if (typeof value === "number" && type instanceof Int64) value = BigInt(value);
    const vector = vectorFromArray([value], type);
    fields.push(new Field(String(i + 1), vector.type, true));
    return vector.data[0]!;
  });
  const schema = new Schema(fields);
  const batch = new RecordBatch(schema, makeData({ type: new Struct(schema.fields), length: 1, children }));
  return new Table([batch]);
}

/**
 * Converts the JSON `params` array from a tool call into the values the client binds.
 * Returns `undefined` when there is nothing to bind.
 */
export function convertParams(params: JsonParamValue[] | undefined): BoundParams | undefined {
  if (!params || params.length === 0) return undefined;
  const converted = params.map((v, i) => convertOne(i, v));
  if (converted.some((c) => c.arrowType !== undefined)) return arrowRow(converted);
  return converted.map((c) => c.value as JsonScalar);
}

/** How many values `bound` carries (one per placeholder). */
export function boundCount(bound: BoundParams | undefined): number {
  if (bound === undefined) return 0;
  return bound instanceof Table ? bound.numCols : bound.length;
}

/** Documentation for the `params` argument, shared by run_query / execute_statement. */
export const PARAMS_DESCRIPTION =
  "Optional JSON array of values bound positionally to ? or $1, $2, ... placeholders in the SQL " +
  "(bound parameters, never string interpolation). Use placeholders for any literal that " +
  "comes from user input or data. Accepted values: string, number, boolean, null. The server types " +
  "each value from where it is used, so an ISO-8601 date string compared with or inserted into a " +
  "DATE/TIMESTAMP column is read as a date. For explicit types use " +
  '{"type":"bigint"|"date"|"timestamp"|"binary"|"string"|"number"|"boolean"|"null","value":...} ' +
  "(binary values are base64; bigint as a digit string for values beyond 2^53). A placeholder whose " +
  "type nothing gives (e.g. SELECT ?) is text unless typed or cast, e.g. SELECT ?::INTEGER.";
