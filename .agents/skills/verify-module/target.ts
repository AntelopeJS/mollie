import type { MolliePayment } from "../../../src/mollie/types.ts";
import { isString, jsonOrText, pick, type Json } from "./json.ts";

/** An account the session configures the module with. */
export type Account = "primary" | "second";

/** A status a payment reaches at Mollie. */
export type PaymentStatus = MolliePayment["status"];

/**
 * Each account as the module knows it: the API key in its config, the webhook URL it sends, and the `provider` a call names it by.
 * The keys are the session's own. The stand-in knows them; the live target forwards each under the operator's test key, so they only tell the accounts apart.
 */
export const ACCOUNTS = {
  primary: { key: `test_${"verifyprimary".padEnd(30, "0")}`, webhookUrl: "https://example.com/mollie/webhook", provider: null },
  second: { key: `test_${"verifysecond".padEnd(30, "0")}`, webhookUrl: "https://example.com/mollie/webhook/second", provider: "second" },
} as const satisfies Record<Account, { key: string; webhookUrl: string; provider: string | null }>;

export const ACCOUNT_NAMES: Account[] = ["primary", "second"];

/** One request Mollie received from the module, as the stand-in records it. */
export interface RecordedCall {
  method: string;
  path: string;
  idempotencyKey: string | null;
  body: Json;
}

/** A recorded request read from its JSON form; `null` when it lacks a method or a path. */
export function toCall(entry: Json): RecordedCall | null {
  const method = pick(entry, "method");
  const path = pick(entry, "path");
  if (!isString(method) || !isString(path)) return null;
  const idempotencyKey = pick(entry, "idempotencyKey");
  return { method, path, idempotencyKey: isString(idempotencyKey) ? idempotencyKey : null, body: pick(entry, "body") ?? null };
}

/** How long a request to Mollie may go without a whole answer before the session counts Mollie as unavailable: below the 15 s the harness's driver gives one call through core. */
export const ANSWER_WITHIN_MS = 10_000;

/** What Mollie answered a request, as it came. */
export interface RawAnswer {
  status: number;
  contentType: string | null;
  body: string;
}

/** `fetch` with a deadline: it rejects when the status and the whole body have not arrived within `ANSWER_WITHIN_MS`. */
export function fetchWithin(url: string, init: RequestInit): Promise<RawAnswer> {
  const signal = AbortSignal.timeout(ANSWER_WITHIN_MS);
  const expired = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error(`no answer within ${ANSWER_WITHIN_MS} ms`)), { once: true });
  });
  const answered = (async () => {
    const response = await fetch(url, { ...init, signal });
    return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
  })();
  return Promise.race([answered, expired]);
}

/** What Mollie answered a request: the status, and the parsed JSON body, `null` when it is empty and the text when it is not JSON. */
export interface WireAnswer {
  status: number;
  json: Json;
}

/** One request as a client of Mollie sends it, under an API key. */
export async function send(url: string, method: string, key: string, body?: Json): Promise<WireAnswer> {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const answer = await fetchWithin(url, init);
  return { status: answer.status, json: jsonOrText(answer.body) };
}

/** Takes a webhook delivery as Mollie sends it: the webhook URL and the form body. */
export type WebhookReceiver = (url: string, body: string) => Promise<void>;

/** The Mollie side of a session: the module's own stand-in, or Mollie's test mode behind a recording proxy. */
export interface MollieTarget {
  readonly kind: "stand-in" | "live";
  /** The `apiUrl` the module is configured with. */
  readonly apiUrl: string;
  /** While set, every request of the module is answered with this status, as during an outage at Mollie, and is not recorded. */
  outage: number | undefined;
  /** The requests Mollie received from the module under an account, oldest first. */
  calls(account: Account): RecordedCall[];
  /** A request the session sends Mollie itself, under the account's key; it is not one of the module's calls. */
  wire(method: string, path: string, account: Account, body?: Json): Promise<WireAnswer>;
  /** Moves a payment to `status` as the payer or the bank would, then lets Mollie notify the payment's webhook; resolves to the webhook URL it notified, `null` when the payment has none. */
  settle(id: string, status: PaymentStatus, account: Account): Promise<string | null>;
  receiveWebhooks(receiver: WebhookReceiver | undefined): void;
  /** Every request Mollie received from the module, one JSON line each, for the evidence. */
  transcript(): string;
  /** Why Mollie was unavailable during the session (an error status of 500 or above, no answer in time, a checkout page it did not serve), or `null` while it answered every request. */
  unreachable(): string | null;
  stop(): Promise<void>;
}
