import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import type { BrowserCheckout } from "../../../src/test/support/browser-checkout.ts";
import { isRecord, isString, jsonOrText, pick, type Json, type JsonRecord } from "./json.ts";
import { ACCOUNTS, ACCOUNT_NAMES, fetchWithin, send, type Account, type RawAnswer, type MollieTarget, type PaymentStatus, type RecordedCall, type WebhookReceiver, type WireAnswer } from "./target.ts";

const MOLLIE_API = "https://api.mollie.com";
const OUTAGE_DETAIL = "The service is temporarily unavailable";
const PAYER_METHOD = "creditcard";
const PAYER_LOCALE = "en_US";
const PAYER_ATTEMPTS = 4;
const PAYER_BACKOFF_MS = 1000;
const NETWORK_ERROR = /net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/;
const SERVER_ERROR = 500;
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

/** A request body as the proxy records it: the parsed JSON, `{}` when it is empty as the stand-in records it, and the text itself when it is not JSON. */
function bodyOf(raw: Buffer): Json {
  const parsed = jsonOrText(raw.toString("utf8"));
  return parsed === null ? {} : parsed;
}

/** Why an answer of 500 or above makes Mollie unavailable: the request, the status, and Mollie's title and detail, or the start of a body that is not JSON. */
function serverError(request: string, status: number, answer: Json): string {
  const said = isString(answer) ? answer.slice(0, 200) : [pick(answer, "title"), pick(answer, "detail")].filter(isString).join(": ");
  return `Mollie answered ${request} with ${status}${said === "" ? "" : ` (${said})`}`;
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
  private readonly inflight = new Set<Promise<void>>();
  private readonly server = createServer((message, response) => this.track(this.forward(message, response)));
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
    const request = `${method} ${path}`;
    let answer: WireAnswer;
    try {
      answer = await send(`${MOLLIE_API}${path}`, method, this.keys[account], body);
    } catch (error) {
      this.lose(`Mollie did not answer ${request}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    if (answer.status < SERVER_ERROR) return answer;
    const reason = serverError(request, answer.status, answer.json);
    this.lose(reason);
    throw new Error(reason);
  }

  async settle(id: string, status: PaymentStatus, account: Account): Promise<string | null> {
    const held = (await this.wire("GET", `/v2/payments/${id}`, account)).json;
    if (pick(held, "status") === "open") await this.pay(id, held, status, account);
    const settled = await this.settled(id, account);
    const reached = pick(settled, "status");
    if (reached !== status) throw new Error(`Mollie holds ${id} as ${JSON.stringify(reached ?? null)}, not ${status}`);
    if (status === "paid" && pick(settled, "sequenceType") === "first") await this.validMandate(id, account);
    const webhookUrl = pick(settled, "webhookUrl");
    if (!isString(webhookUrl)) return null;
    await this.receiver?.(webhookUrl, `id=${id}`);
    return webhookUrl;
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
    await Promise.allSettled(this.inflight);
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.checkout.close();
  }

  private lose(reason: string): void {
    this.lost ??= reason;
  }

  /** Keeps a forwarded request until it is answered, so `stop` reads `unreachable` only after every request had its answer or its deadline. */
  private track(exchange: Promise<void>): void {
    this.inflight.add(exchange);
    void exchange.finally(() => this.inflight.delete(exchange));
  }

  /**
   * Completes the payment's checkout as the payer, after Mollie's API sets what the payer would pick on its pages. A page that fails to load is tried
   * again while the payment stays open, 1 s, 3 s and 9 s later; when the last attempt still fails on the network, Mollie's pages count as unavailable.
   */
  private async pay(id: string, held: Json, status: PaymentStatus, account: Account): Promise<void> {
    const choices = payerChoices(held);
    const page = Object.keys(choices).length === 0 ? held : (await this.wire("PATCH", `/v2/payments/${id}`, account, choices)).json;
    const link = pick(page, "_links", "checkout", "href") ?? pick(page, "_links", "changePaymentState", "href");
    if (!isString(link)) throw new Error(`Mollie offers no page to settle ${id} on`);
    for (let attempt = 1; ; attempt += 1) {
      let failure: Error;
      try {
        await this.checkout.complete(link, status);
        return;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
      const still = pick((await this.wire("GET", `/v2/payments/${id}`, account)).json, "status");
      if (still !== "open") return;
      if (attempt === PAYER_ATTEMPTS) throw this.payerFailure(id, failure);
      await pause(PAYER_BACKOFF_MS * 3 ** (attempt - 1));
    }
  }

  /** The error the last checkout attempt ends with; one the network caused makes Mollie's pages unavailable. */
  private payerFailure(id: string, failure: Error): Error {
    const [summary = ""] = failure.message.split("\n");
    if (NETWORK_ERROR.test(summary)) this.lose(`Mollie's checkout page for ${id} could not be reached in ${PAYER_ATTEMPTS} attempts: ${summary}`);
    return failure;
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
    const raw = await buffer(message).catch(() => null);
    if (raw === null) return;
    if (this.outage !== undefined) {
      reply(response, this.outage, JSON.stringify({ status: this.outage, title: "Service Unavailable", detail: OUTAGE_DETAIL }));
      return;
    }
    const url = new URL(message.url ?? "/", this.apiUrl);
    const presented = header(message, "authorization") ?? "";
    const account = ACCOUNT_NAMES.find((name) => presented === `Bearer ${ACCOUNTS[name].key}`) ?? null;
    const call: RecordedCall = { method: message.method ?? "GET", path: url.pathname, idempotencyKey: header(message, "idempotency-key"), body: bodyOf(raw) };
    if (account !== null) this.recorded[account].push(call);
    const headers = new Headers({ Authorization: account === null ? presented : `Bearer ${this.keys[account]}` });
    const passed: [string, string | null][] = [
      ["Accept", header(message, "accept")],
      ["Content-Type", header(message, "content-type")],
      ["Idempotency-Key", call.idempotencyKey],
      ["User-Agent", header(message, "user-agent")],
    ];
    for (const [name, value] of passed) if (value !== null) headers.set(name, value);
    const request = `${call.method} ${url.pathname}`;
    let answer: RawAnswer;
    try {
      answer = await fetchWithin(`${MOLLIE_API}${url.pathname}${url.search}`, { method: call.method, headers, body: raw.length === 0 ? undefined : raw });
    } catch (error) {
      this.lose(`Mollie did not answer ${request}: ${error instanceof Error ? error.message : String(error)}`);
      reply(response, 502, JSON.stringify({ status: 502, title: "Bad Gateway", detail: `the verify proxy got no answer from Mollie to ${request}` }));
      return;
    }
    const json = jsonOrText(answer.body);
    this.exchanges.push({ account, ...call, query: url.search, status: answer.status, answer: summary(json) });
    if (answer.status >= SERVER_ERROR) this.lose(serverError(request, answer.status, json));
    reply(response, answer.status, answer.body, answer.contentType ?? undefined);
  }
}

/** Starts the recording proxy in front of Mollie's test mode, with the module's test payer ready to complete checkouts. */
export async function startLive(repo: string, keys: LiveKeys): Promise<MollieTarget> {
  const target = new LiveTarget(keys, await loadCheckout(repo));
  await target.listen();
  return target;
}
