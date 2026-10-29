export type DefinedFields<T> = { [K in keyof T]?: T[K] & ({} | null) };

export function DefinedFields<T extends object>(fields: T): DefinedFields<T> {
  const defined: DefinedFields<T> = {};
  for (const key in fields) {
    const value = fields[key];
    if (
      Object.prototype.hasOwnProperty.call(fields, key) &&
      value !== undefined
    )
      defined[key] = value;
  }
  return defined;
}

function isKeyOf<T extends object>(table: T, key: PropertyKey): key is keyof T {
  return key in table;
}

/**
 * Reads `table[key]` the way plain indexing does, inherited keys included, and
 * returns `undefined` for a key the table does not have.
 */
export function Lookup<T extends object>(
  table: T,
  key: PropertyKey,
): T[keyof T] | undefined {
  return isKeyOf(table, key) ? table[key] : undefined;
}

export function NonEmpty(
  record: Record<string, string>,
): Record<string, string> | undefined {
  return Object.keys(record).length > 0 ? record : undefined;
}
