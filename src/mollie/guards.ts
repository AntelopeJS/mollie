/** A check that `value` has the shape `T`, field by field. */
export type Guard<T> = (value: unknown) => value is T;

type Fields<T> = { [K in keyof T]-?: Guard<T[K]> };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function IsText(value: unknown): value is string {
  return typeof value === "string";
}

export function IsCount(value: unknown): value is number {
  return typeof value === "number";
}

const LATEST_INSTANT = 8.64e15;

/** A whole number of milliseconds since the epoch, not before it, that a `Date` can hold. */
export function IsInstant(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= LATEST_INSTANT
  );
}

export function IsFlag(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function OneOf<const Value extends string>(
  values: readonly Value[],
): Guard<Value> {
  const known = new Set<unknown>(values);
  return (value): value is Value => known.has(value);
}

export function Optional<T>(guard: Guard<T>): Guard<T | undefined> {
  return (value): value is T | undefined => value === undefined || guard(value);
}

export function Nullable<T>(guard: Guard<T>): Guard<T | null | undefined> {
  return (value): value is T | null | undefined =>
    value === null || value === undefined || guard(value);
}

export function ListOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value): value is T[] =>
    Array.isArray(value) && value.every((item) => guard(item));
}

export function RecordOf<T>(guard: Guard<T>): Guard<Record<string, T>> {
  return (value): value is Record<string, T> =>
    isObject(value) && Object.values(value).every((item) => guard(item));
}

/** Checks every field `T` declares, an absent optional one included. */
export function ObjectWith<T>(fields: Fields<T>): Guard<T> {
  return (value): value is T => {
    if (!isObject(value)) return false;
    for (const key in fields) {
      const field = Object.prototype.hasOwnProperty.call(value, key)
        ? value[key]
        : undefined;
      if (!fields[key](field)) return false;
    }
    return true;
  };
}
