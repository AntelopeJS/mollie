import type { Amount } from "@antelopejs/interface-payment";

import { Lookup } from "./fields";
import type { MollieAmount } from "./types";

const DECIMALS_BY_CURRENCY = {
  AED: 2,
  AUD: 2,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  HUF: 2,
  ILS: 2,
  ISK: 0,
  JPY: 0,
  MXN: 2,
  MYR: 2,
  NOK: 2,
  NZD: 2,
  PHP: 2,
  PLN: 2,
  RON: 2,
  RUB: 2,
  SEK: 2,
  SGD: 2,
  THB: 2,
  TWD: 2,
  USD: 2,
  ZAR: 2,
} satisfies Record<string, number>;
const DEFAULT_DECIMALS = 2;
const DECIMAL_SEPARATOR = ".";
const DIGITS = /^\d+$/;
const BASE = 10;

function decimalsOf(currency: string): number {
  const known = Lookup(DECIMALS_BY_CURRENCY, currency);
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
