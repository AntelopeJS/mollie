import type { MollieMetadata } from "./types";

const OWN_KEY = "antelope";
const CALLER_KEY = "metadata";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(metadata: MollieMetadata | undefined): JsonObject {
  if (isObject(metadata)) {
    return metadata;
  }
  if (typeof metadata !== "string") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(metadata);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function strings(value: unknown): Record<string, string> {
  if (!isObject(value)) {
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
  return isObject(own) ? (own as Partial<T>) : undefined;
}

export function ReadCallerMetadata(
  metadata: MollieMetadata | undefined,
): Record<string, string> {
  const parsed = parse(metadata);
  if (OWN_KEY in parsed && isObject(parsed[CALLER_KEY])) {
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
): JsonObject {
  return { [OWN_KEY]: own, [CALLER_KEY]: caller };
}

export function MergeOwn<T extends object>(
  metadata: MollieMetadata | undefined,
  changes: T,
): JsonObject {
  const parsed = parse(metadata);
  const own = isObject(parsed[OWN_KEY]) ? parsed[OWN_KEY] : {};
  return { ...parsed, [OWN_KEY]: { ...own, ...changes } };
}
