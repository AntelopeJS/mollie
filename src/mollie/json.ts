import type { JsonValue } from "./types";

/**
 * Whether `value` is JSON data, checked all the way down: what `JSON.parse`
 * returns. Arrays and plain objects pass, so a `Date`, a `Map` or a class
 * instance does not.
 */
export function IsJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => IsJsonValue(item));
  }
  if (typeof value !== "object") {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value).every((item) => IsJsonValue(item));
}

/** `JSON.parse` with the result typed as the JSON data it always is. */
export function ParseJson(text: string): JsonValue {
  const parsed: unknown = JSON.parse(text);
  if (!IsJsonValue(parsed)) {
    throw new SyntaxError("JSON.parse returned a value that is not JSON data");
  }
  return parsed;
}
