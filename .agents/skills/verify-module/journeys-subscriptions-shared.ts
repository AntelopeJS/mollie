import { PRIMARY_KEY, fresh, isNumber, wire, type Json, type Session } from "./session.ts";

export const MONTHLY = { value: 1900, currency: "EUR" };

export function requestOf(saved: { customer: string; method: string }, extra: Record<string, Json> = {}) {
  return { reference: fresh("sub"), customer: saved.customer, paymentMethod: saved.method, amount: MONTHLY, interval: "month", ...extra };
}

/** What Mollie holds for a subscription, read with the account's key and not through the module. */
export async function subscriptionAtProvider(session: Session, id: string): Promise<Json> {
  const [customer, child] = id.split(":");
  return (await wire(session.base, "GET", `/v2/customers/${customer}/subscriptions/${child}`, PRIMARY_KEY)).json;
}

const AMSTERDAM_CLOCK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Amsterdam",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** The Europe/Amsterdam wall clock of an instant as `[YYYY-MM-DD, HH:MM:SS]`; `null` when the value is not a time. */
export function amsterdamClock(instant: Json | undefined): [string, string] | null {
  if (!isNumber(instant)) return null;
  const parts = Object.fromEntries(AMSTERDAM_CLOCK.formatToParts(instant).map((part) => [part.type, part.value]));
  return [`${parts.year}-${parts.month}-${parts.day}`, `${parts.hour}:${parts.minute}:${parts.second}`];
}

/** The calendar date one month after `date` (`YYYY-MM-DD`), clamped to the last day of that month. */
export function monthAfter(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay))).toISOString().slice(0, 10);
}
