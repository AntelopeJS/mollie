import { PRIMARY_KEY, fresh, wire, type Json, type Session } from "./session.ts";

export const MONTHLY = { value: 1900, currency: "EUR" };

export function requestOf(saved: { customer: string; method: string }, extra: Record<string, Json> = {}) {
  return { reference: fresh("sub"), customer: saved.customer, paymentMethod: saved.method, amount: MONTHLY, interval: "month", ...extra };
}

/** What Mollie holds for a subscription, read with the account's key and not through the module. */
export async function subscriptionAtProvider(session: Session, id: string): Promise<Json> {
  const [customer, child] = id.split(":");
  return (await wire(session.base, "GET", `/v2/customers/${customer}/subscriptions/${child}`, PRIMARY_KEY)).json;
}
