import { ParseJson } from "./json";
import type { JsonObject, JsonValue, MollieMetadata } from "./types";

const OWN_KEY = "antelope";
const CALLER_KEY = "metadata";

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

export function ReadOwn<T extends object>(
  metadata: MollieMetadata | undefined,
): Partial<T> | undefined {
  const own = parse(metadata)[OWN_KEY];
  return IsJsonObject(own) ? (own as Partial<T>) : undefined;
}

export function ReadCallerMetadata(
  metadata: MollieMetadata | undefined,
): Record<string, string> {
  const parsed = parse(metadata);
  if (OWN_KEY in parsed && IsJsonObject(parsed[CALLER_KEY])) {
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

export function MergeOwn<T extends object>(
  metadata: MollieMetadata | undefined,
  changes: T,
) {
  const parsed = parse(metadata);
  const own = IsJsonObject(parsed[OWN_KEY]) ? parsed[OWN_KEY] : {};
  return { ...parsed, [OWN_KEY]: { ...own, ...changes } };
}
