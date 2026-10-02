export type DefinedFields<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

export function DefinedFields<T extends object>(fields: T): DefinedFields<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as DefinedFields<T>;
}

export function NonEmpty(
  record: Record<string, string>,
): Record<string, string> | undefined {
  return Object.keys(record).length > 0 ? record : undefined;
}
