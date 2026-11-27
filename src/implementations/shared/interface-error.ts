/**
 * Whether `error` is an instance of the interface error class `type` or of a
 * subclass of it, matched by class name along the prototype chain.
 *
 * `instanceof` is false for an error built by another copy of the interface
 * package, which an application can load next to this module's copy.
 */
export function IsInterfaceError<E extends Error>(
  error: unknown,
  type: abstract new (...args: never[]) => E,
): error is E {
  if (!(error instanceof Error)) return false;
  for (
    let prototype = Reflect.getPrototypeOf(error);
    prototype !== null;
    prototype = Reflect.getPrototypeOf(prototype)
  ) {
    const constructor: unknown = Object.getOwnPropertyDescriptor(
      prototype,
      "constructor",
    )?.value;
    if (typeof constructor === "function" && constructor.name === type.name) {
      return true;
    }
  }
  return false;
}
