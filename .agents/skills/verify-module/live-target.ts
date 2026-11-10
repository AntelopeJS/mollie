import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import type { BrowserCheckout } from "../../../src/test/support/browser-checkout.ts";
import { isRecord, isString, parseJson, pick, recordOf, type Json, type JsonRecord } from "./json.ts";
import { ACCOUNTS, ACCOUNT_NAMES, send, type Account, type MollieTarget, type PaymentStatus, type RecordedCall, type WebhookReceiver, type WireAnswer } from "./target.ts";

const MOLLIE_API = "https://api.mollie.com";
const OUTAGE_DETAIL = "The service is temporarily unavailable";
const PAYER_METHOD = "creditcard";
const PAYER_LOCALE = "en_US";
const PAYER_ATTEMPTS = 3;
const SETTLE_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
const UNSETTLED = new Set<Json | undefined>(["open", "pending"]);
const ANSWER_FIELDS = ["id", "status", "mode", "detail", "count"];

/** The operator's Mollie test-mode key each account's requests go out under. */
export type LiveKeys = Record<Account, string>;

/** The test payer of the module's live suite (`src/test/support/browser-checkout.ts`), as the build exports it. */
type Checkout = Pick<BrowserCheckout, "complete" | "close">;

/** One request the proxy forwarded and what Mollie answered it. */
interface Exchange extends RecordedCall {
  account: Account | null;
  query: string;
  status: number;
  answer: Json;
}

function isClass(value: unknown): value is new () => object {
  return typeof value === "function";
}

function isTcpAddress(address: string | AddressInfo | null): address is AddressInfo {
  return typeof address === "object" && address !== null;
}

function isCheckout(value: unknown): value is Checkout {
  return isRecord(value) && typeof value.complete === "function" && typeof value.close === "function";
}

async function loadCheckout(repo: string): Promise<Checkout> {
  const loaded: unknown = await import(pathToFileURL(join(repo, "dist/test/support/browser-checkout.js")).href);
  const { BrowserCheckout: CheckoutClass } = isRecord(loaded) ? loaded : {};
  if (!isClass(CheckoutClass)) throw new Error("dist/test/support/browser-checkout.js does not export BrowserCheckout: run the build first");
  const instance: unknown = Reflect.construct(CheckoutClass, []);
  if (!isCheckout(instance)) throw new Error("BrowserCheckout does not have complete and close");
  return instance;
}

function header(message: IncomingMessage, name: string): string | null {
  const value = message.headers[name];
  return isString(value) ? value : null;
}

function answerOf(raw: string): Json {
  try {
    return parseJson(raw);
  } catch {
    return raw;
  }
}

function summary(answer: Json): Json {
  return Object.fromEntries(
    ANSWER_FIELDS.flatMap((field): [string, Json][] => {
      const value = pick(answer, field);
      return value === undefined ? [] : [[field, value]];
    }),
  );
}

/** What the payer picks on Mollie's pages that the payment leaves open: a card when it has no method, and English, the only language the test payer reads. */
function payerChoices(held: Json): JsonRecord {
  const choices: JsonRecord = {};
  if (pick(held, "method") === null) choices.method = PAYER_METHOD;
  const locale = pick(held, "locale");
  if (isString(locale) && !locale.startsWith("en")) choices.locale = PAYER_LOCALE;
  return choices;
}

function reply(response: ServerResponse, status: number, body: string, contentType = "application/hal+json"): void {
  response.writeHead(status, { "Content-Type": contentType });
  response.end(body);
}

/**
 * Mollie's test mode behind a local recording proxy. The module's `apiUrl` points at the proxy, which records each request under the account
 * whose session key it carries, as the stand-in does, then forwards it to api.mollie.com under that account's test key. A key no account has
 * goes out unchanged, so Mollie judges it. The session's own requests go to Mollie directly and are not recorded.
 */
class LiveTarget implements MollieTarget {
  readonly kind = "live";
  apiUrl = "";
  outage: number | undefined;
  private readonly recorded: Record<Account, RecordedCall[]> = { primary: [], second: [] };
  private readonly exchanges: Exchange[] = [];
  private receiver: WebhookReceiver | undefined;
  private lost: string | null = null;
  private readonly server = createServer((message, response) => void this.forward(message, response));
  private readonly keys: LiveKeys;
  private readonly checkout: Checkout;

  constructor(keys: LiveKeys, checkout: Checkout) {
    this.keys = keys;
    this.checkout = checkout;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!isTcpAddress(address)) throw new Error("the recording proxy is not listening on a TCP port");
    this.apiUrl = `http://127.0.0.1:${address.port}`;
  }

  calls(account: Account): RecordedCall[] {
    return [...this.recorded[account]];
  }

  async wire(method: string, path: string, account: Account, body?: Json): Promise<WireAnswer> {
    try {
      return await send(`${MOLLIE_API}${path}`, method, this.keys[account], body);
    } catch (error) {
      this.lost ??= error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async settle(id: string, status: PaymentStatus, account: Account): Promise<void> {
    const held = (await this.wire("GET", `/v2/payments/${id}`, account)).json;
    if (pick(held, "status") === "open") await this.pay(id, held, status, account);
    const settled = await this.settled(id, account);
    const reached = pick(settled, "status");
    if (reached !== status) throw new Error(`Mollie holds ${id} as ${JSON.stringify(reached ?? null)}, not ${status}`);
    if (status === "paid" && pick(settled, "sequenceType") === "first") await this.validMandate(id, account);
    const webhookUrl = pick(settled, "webhookUrl");
    if (isString(webhookUrl)) await this.receiver?.(webhookUrl, `id=${id}`);
  }

  receiveWebhooks(receiver: WebhookReceiver | undefined): void {
    this.receiver = receiver;
  }

  transcript(): string {
    return this.exchanges.map((exchange) => JSON.stringify(exchange)).join("\n");
  }

  unreachable(): string | null {
    return this.lost;
  }

  async stop(): Promise<void> {
    this.receiver = undefined;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.checkout.close();
  }

  /** Completes the payment's checkout as the payer, after Mollie's API sets what the payer would pick on its pages; a page that fails to load is tried again, up to three times, while the payment stays open. */
  private async pay(id: string, held: Json, status: PaymentStatus, account: Account): Promise<void> {
    const choices = payerChoices(held);
    const page = Object.keys(choices).length === 0 ? held : (await this.wire("PATCH", `/v2/payments/${id}`, account, choices)).json;
    const link = pick(page, "_links", "checkout", "href") ?? pick(page, "_links", "changePaymentState", "href");
    if (!isString(link)) throw new Error(`Mollie offers no page to settle ${id} on`);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.checkout.complete(link, status);
        return;
      } catch (error) {
        const still = pick((await this.wire("GET", `/v2/payments/${id}`, account)).json, "status");
        if (still !== "open") return;
        if (attempt === PAYER_ATTEMPTS) throw error;
      }
    }
  }

  private async settled(id: string, account: Account): Promise<Json> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let payment = (await this.wire("GET", `/v2/payments/${id}`, account)).json;
    while (UNSETTLED.has(pick(payment, "status")) && Date.now() < deadline) {
      await pause(POLL_MS);
      payment = (await this.wire("GET", `/v2/payments/${id}`, account)).json;
    }
    return payment;
  }

  /** Waits for the mandate a paid first payment leaves: Mollie reads the payment `paid` a few hundred milliseconds before its mandate turns valid. */
  private async validMandate(id: string, account: Account): Promise<void> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const payment = (await this.wire("GET", `/v2/payments/${id}`, account)).json;
      const [customer, mandate] = [pick(payment, "customerId"), pick(payment, "mandateId")];
      const held = isString(customer) && isString(mandate) ? (await this.wire("GET", `/v2/customers/${customer}/mandates/${mandate}`, account)).json : null;
      if (pick(held, "status") === "valid") return;
      await pause(POLL_MS);
    }
    throw new Error(`the mandate of ${id} did not turn valid within ${SETTLE_TIMEOUT_MS} ms`);
  }

  private async forward(message: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const raw = await text(message);
      if (this.outage !== undefined) {
        reply(response, this.outage, JSON.stringify({ status: this.outage, title: "Service Unavailable", detail: OUTAGE_DETAIL }));
        return;
      }
      const url = new URL(message.url ?? "/", this.apiUrl);
      const presented = header(message, "authorization") ?? "";
      const account = ACCOUNT_NAMES.find((name) => presented === `Bearer ${ACCOUNTS[name].key}`) ?? null;
      const call: RecordedCall = { method: message.method ?? "GET", path: url.pathname, idempotencyKey: header(message, "idempotency-key"), body: recordOf(parseJson(raw)) };
      if (account !== null) this.recorded[account].push(call);
      const headers = new Headers({ Authorization: account === null ? presented : `Bearer ${this.keys[account]}` });
      const passed: [string, string | null][] = [
        ["Accept", header(message, "accept")],
        ["Content-Type", header(message, "content-type")],
        ["Idempotency-Key", call.idempotencyKey],
        ["User-Agent", header(message, "user-agent")],
      ];
      for (const [name, value] of passed) if (value !== null) headers.set(name, value);
      const answer = await fetch(`${MOLLIE_API}${url.pathname}${url.search}`, { method: call.method, headers, body: raw === "" ? undefined : raw });
      const body = await answer.text();
      this.exchanges.push({ account, ...call, query: url.search, status: answer.status, answer: summary(answerOf(body)) });
      reply(response, answer.status, body, answer.headers.get("content-type") ?? undefined);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.lost ??= reason;
      reply(response, 502, JSON.stringify({ status: 502, title: "Bad Gateway", detail: `the verify proxy could not reach Mollie: ${reason}` }));
    }
  }
}

/** Starts the recording proxy in front of Mollie's test mode, with the module's test payer ready to complete checkouts. */
export async function startLive(repo: string, keys: LiveKeys): Promise<MollieTarget> {
  const target = new LiveTarget(keys, await loadCheckout(repo));
  await target.listen();
  return target;
}
