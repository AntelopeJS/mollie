import type { Guard } from "./guards";
import { ParseJson } from "./json";
import type { JsonObject, JsonValue, MollieMetadata } from "./types";

const OWN_KEY = "antelope";
const CALLER_KEY = "metadata";
const KEPT_KEY = "kept";
const FOREIGN_KEY = "foreign";
const METADATA_BYTES = 1024;

/**
 * Whether `metadata` is within Mollie's limit on one resource's metadata,
 * "approximately 1kB" in Mollie's OpenAPI specification, counted as the UTF-8
 * bytes of its JSON text. Mollie answers 422 "The metadata storage is
 * currently limited to 1024 bytes" to a larger write.
 */
export function FitsMetadataLimit(
  metadata: ReturnType<typeof MergeOwn>,
): boolean {
  return Buffer.byteLength(JSON.stringify(metadata), "utf8") <= METADATA_BYTES;
}

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

function parse(metadata: MollieMetadata | undefined): JsonObject {
  if (IsJsonObject(metadata)) {
    return metadata;
  }
  if (!IsJsonString(metadata)) {
    return {};
  }
  try {
    const parsed = ParseJson(metadata);
    return IsJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function keptText(parsed: JsonObject): string | undefined {
  const own = parsed[OWN_KEY];
  return IsJsonObject(own) && IsJsonString(own[KEPT_KEY])
    ? own[KEPT_KEY]
    : undefined;
}

function ownOf(parsed: JsonObject): JsonValue | undefined {
  const own = parsed[OWN_KEY];
  const kept = keptText(parsed);
  if (kept === undefined || !IsJsonObject(own)) {
    return own;
  }
  const keptOwn = parse(kept)[OWN_KEY];
  return IsJsonObject(keptOwn) ? { ...keptOwn, ...own } : own;
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
  const own = ownOf(parse(metadata));
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
 * record, or, in metadata the module did not write, its string entries. For
 * a string kept in the own record, it is what the string read as before.
 */
export function ReadCallerMetadata(
  metadata: MollieMetadata | undefined,
): Record<string, string> {
  const outer = parse(metadata);
  const kept = keptText(outer);
  const parsed = kept === undefined ? outer : parse(kept);
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
  object: JsonObject | undefined,
): JsonObject {
  if (object === undefined) {
    return metadata === undefined || metadata === null
      ? {}
      : { [KEPT_KEY]: metadata };
  }
  if (!(OWN_KEY in object)) {
    return IsJsonObject(object[CALLER_KEY]) ? { [FOREIGN_KEY]: true } : {};
  }
  const own = object[OWN_KEY];
  return IsJsonObject(own) ? own : {};
}

/**
 * Sets `changes` in the module's own record and leaves what the caller reads
 * as it was. Metadata that is not an object, a string holding a JSON object
 * included, is kept as it is in the own record under `kept`. Another writer's
 * object keeps its keys, and when it holds a `metadata` object of its own, the
 * own record gets `foreign: true` so the caller still reads the object's
 * string entries.
 */
export function MergeOwn<T extends object>(
  metadata: MollieMetadata | undefined,
  changes: T,
) {
  const object = IsJsonObject(metadata) ? metadata : undefined;
  return {
    ...object,
    [OWN_KEY]: { ...ownBefore(metadata, object), ...changes },
  };
}
