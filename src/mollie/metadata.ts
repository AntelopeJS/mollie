import type { Guard } from "./guards";
import { ParseJson } from "./json";
import type { JsonObject, JsonValue, MollieMetadata } from "./types";

const OWN_KEY = "antelope";
const CALLER_KEY = "metadata";
const KEPT_KEY = "kept";
const FOREIGN_KEY = "foreign";

export function IsJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function IsJsonString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function IsJsonNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}

function objectOf(
  metadata: MollieMetadata | undefined,
): JsonObject | undefined {
  if (IsJsonObject(metadata)) {
    return metadata;
  }
  if (!IsJsonString(metadata)) {
    return undefined;
  }
  try {
    const parsed = ParseJson(metadata);
    return IsJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parse(metadata: MollieMetadata | undefined): JsonObject {
  return objectOf(metadata) ?? {};
}

function strings(value: JsonValue | undefined): Record<string, string> {
  if (!IsJsonObject(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** A guard for each field a caller keeps under the module's own key. */
export type OwnFields<T> = {
  [K in keyof T]-?: Guard<Exclude<T[K], undefined>>;
};

/**
 * The fields the module keeps under its own key that pass their guard.
 * Anything holding the API key can write Mollie metadata, so a field of
 * another type is dropped.
 */
export function ReadOwn<T extends object>(
  metadata: MollieMetadata | undefined,
  fields: OwnFields<T>,
): Partial<T> | undefined {
  const own = parse(metadata)[OWN_KEY];
  if (!IsJsonObject(own)) {
    return undefined;
  }
  const read: Partial<T> = {};
  for (const key in fields) {
    const value = Object.prototype.hasOwnProperty.call(own, key)
      ? own[key]
      : undefined;
    if (fields[key](value)) {
      read[key] = value;
    }
  }
  return read;
}

function isForeign(own: JsonValue | undefined): boolean {
  return IsJsonObject(own) && own[FOREIGN_KEY] === true;
}

/**
 * The caller's metadata: the `metadata` object beside the module's own
 * record, or, in metadata the module did not write, its string entries.
 */
export function ReadCallerMetadata(
  metadata: MollieMetadata | undefined,
): Record<string, string> {
  const parsed = parse(metadata);
  if (
    OWN_KEY in parsed &&
    IsJsonObject(parsed[CALLER_KEY]) &&
    !isForeign(parsed[OWN_KEY])
  ) {
    return strings(parsed[CALLER_KEY]);
  }
  return strings(
    Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key !== OWN_KEY),
    ),
  );
}

export function WriteMetadata<T extends object>(
  own: T,
  caller: Record<string, string> = {},
) {
  return { [OWN_KEY]: own, [CALLER_KEY]: caller };
}

function ownBefore(
  metadata: MollieMetadata | undefined,
  parsed: JsonObject | undefined,
): JsonObject {
  if (parsed === undefined) {
    return metadata === undefined || metadata === null
      ? {}
      : { [KEPT_KEY]: metadata };
  }
  if (!(OWN_KEY in parsed)) {
    return IsJsonObject(parsed[CALLER_KEY]) ? { [FOREIGN_KEY]: true } : {};
  }
  const own = parsed[OWN_KEY];
  return IsJsonObject(own) ? own : {};
}

/**
 * Sets `changes` in the module's own record and leaves what the caller reads
 * as it was. Metadata that is not an object is kept in the own record under
 * `kept`. Another writer's object keeps its keys, and when it holds a
 * `metadata` object of its own, the own record gets `foreign: true` so the
 * caller still reads the object's string entries.
 */
export function MergeOwn<T extends object>(
  metadata: MollieMetadata | undefined,
  changes: T,
) {
  const parsed = objectOf(metadata);
  return {
    ...parsed,
    [OWN_KEY]: { ...ownBefore(metadata, parsed), ...changes },
  };
}
