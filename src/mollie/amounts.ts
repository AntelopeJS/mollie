import type { Amount } from "@antelopejs/interface-payment";

import type { MollieAmount } from "./types";

const DECIMALS_BY_CURRENCY: Record<string, number> = {
  ISK: 0,
  JPY: 0,
};
const DEFAULT_DECIMALS = 2;
const DECIMAL_SEPARATOR = ".";
const DIGITS = /^\d+$/;
const BASE = 10;

function decimalsOf(currency: string): number {
  const known = DECIMALS_BY_CURRENCY[currency];
  if (known !== undefined) {
    return known;
  }
  return (
    new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? DEFAULT_DECIMALS
  );
}

export function ToMollieAmount(amount: Amount): MollieAmount {
  if (!Number.isSafeInteger(amount.value) || amount.value < 0) {
    throw new RangeError(
      `Amount ${amount.value} is not a non-negative whole number of minor units`,
    );
  }
  const currency = amount.currency.toUpperCase();
  const decimals = decimalsOf(currency);
  const digits = String(amount.value).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  return {
    currency,
    value: decimals > 0 ? `${whole}${DECIMAL_SEPARATOR}${fraction}` : whole,
  };
}

export function FromMollieAmount(amount: MollieAmount): Amount {
  const currency = amount.currency.toUpperCase();
  const decimals = decimalsOf(currency);
  const parts = amount.value.split(DECIMAL_SEPARATOR);
  const [whole = "", fraction = ""] = parts;
  const padded = fraction.padEnd(decimals, "0");
  if (
    parts.length > 2 ||
    !DIGITS.test(whole) ||
    padded.length !== decimals ||
    (padded && !DIGITS.test(padded))
  ) {
    throw new RangeError(
      `Mollie amount "${amount.value}" does not have ${decimals} decimals for ${currency}`,
    );
  }
  return {
    currency,
    value: Number.parseInt(`${whole}${padded}`, BASE),
  };
}

export function ZeroAmount(currency: string): Amount {
  return { value: 0, currency: currency.toUpperCase() };
}
