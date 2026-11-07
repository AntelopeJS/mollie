import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  equal,
  type App,
  type CallResult,
  type Check,
  type JourneyContext,
} from "@antelopejs/tooling-configs/verify";

import type { MollieStandIn } from "../../../src/test/stand-in/server.ts";
import type { MolliePayment } from "../../../src/mollie/types.ts";
import { canonical, isRecord, isString, parseJson, pick, text, tuple, type Json } from "./json.ts";

export { isNumber, pick, text, tuple, type Json } from "./json.ts";
export type ModuleConfig = NonNullable<NonNullable<Parameters<JourneyContext["fixture"]>[0]>["moduleConfig"]>;

export const PRIMARY_KEY = `test_${"verifyprimary".padEnd(30, "0")}`;
export const SECOND_KEY = `test_${"verifysecond".padEnd(30, "0")}`;
export const WEBHOOK_URL = "https://merchant.invalid/mollie/webhook";
export const SECOND_WEBHOOK_URL = "https://merchant.invalid/mollie/webhook/second";
export const RETURN_URL = "https://merchant.invalid/return";
export const SECOND_ACCOUNT = "second";

export const EUR = { value: 1050, currency: "EUR" } as const;

/** The members of the module's own stand-in for Mollie (`src/test/stand-in`) that the skill drives, as the built suite exports it. */
export type StandIn = Pick<MollieStandIn, "start" | "stop" | "receiveWebhooks" | "account" | "settle">;

function isStandIn(value: unknown): value is StandIn {
  return (
    isRecord(value) &&
    typeof value.start === "function" &&
    typeof value.stop === "function" &&
    typeof value.receiveWebhooks === "function" &&
    typeof value.account === "function" &&
    typeof value.settle === "function"
  );
}

function isConstructor(value: unknown): value is new (apiKeys: string[]) => object {
  return typeof value === "function";
}

async function loadStandIn(repo: string): Promise<StandIn> {
  const loaded: unknown = await import(pathToFileURL(join(repo, "dist/test/stand-in/server.js")).href);
  const exported = isRecord(loaded) ? loaded : {};
  const { MollieStandIn: StandInClass } = exported;
  if (!isConstructor(StandInClass)) throw new Error("dist/test/stand-in/server.js does not export MollieStandIn: run the build first");
  const instance: unknown = Reflect.construct(StandInClass, [[PRIMARY_KEY, SECOND_KEY]]);
  if (!isStandIn(instance)) throw new Error("the stand-in does not have the members the skill drives");
  return instance;
}

/** One call the stand-in answered, as it recorded it. */
export interface RecordedCall {
  method: string;
  path: string;
  idempotencyKey: string | null;
  body: Json;
}

function toCall(entry: Json): RecordedCall | null {
  const method = pick(entry, "method");
  const path = pick(entry, "path");
  if (!isString(method) || !isString(path)) return null;
  const idempotencyKey = pick(entry, "idempotencyKey");
  return { method, path, idempotencyKey: isString(idempotencyKey) ? idempotencyKey : null, body: pick(entry, "body") ?? null };
}

/** One webhook delivery the session passed to `VerifyWebhook`: whether the module answered, and what it answered. */
export interface Delivery {
  ok: boolean;
  detail: string;
}

export interface Session {
  context: JourneyContext;
  app: App;
  standIn: StandIn;
  base: string;
  calls: number;
  /** The outcome of each finished webhook delivery, per payment id, oldest first. */
  delivered: Map<string, Delivery[]>;
}

/** The module config for a session: the default account, a `second` one with its own key, both pointed at the stand-in. */
export function sessionConfig(base: string, overrides: ModuleConfig = {}): ModuleConfig {
  return {
    apiKey: PRIMARY_KEY,
    apiUrl: base,
    webhookUrl: WEBHOOK_URL,
    accounts: { [SECOND_ACCOUNT]: { apiKey: SECOND_KEY, webhookUrl: SECOND_WEBHOOK_URL } },
    ...overrides,
  };
}

/** Starts the stand-in, loads the module in `ajs project dev` with its `apiUrl` and keys, forwards the stand-in's webhook deliveries to `VerifyWebhook` through core for the account whose webhook URL they reach, and hands both to `run`. */
export async function withSession(context: JourneyContext, run: (session: Session) => Promise<void>, overrides: ModuleConfig = {}): Promise<void> {
  const standIn = await loadStandIn(context.repo);
  const base = await standIn.start();
  try {
    const app = await context.dev("ajs-project-dev", context.fixture({ moduleConfig: sessionConfig(base, overrides) }));
    const session: Session = { context, app, standIn, base, calls: 0, delivered: new Map() };
    standIn.receiveWebhooks(async (url, body) => {
      session.calls += 1;
      const id = new URLSearchParams(body).get("id") ?? "";
      const outcomes = session.delivered.get(id) ?? [];
      session.delivered.set(id, outcomes);
      let outcome: Delivery = { ok: false, detail: "the call through core did not return" };
      try {
        const delivered = await context.call(`webhook delivery ${session.calls}`, app, {
          path: ["VerifyWebhook"],
          args: [{ body: [...Buffer.from(body)], headers: { "content-type": "application/x-www-form-urlencoded" } }, url === SECOND_WEBHOOK_URL ? SECOND_ACCOUNT : null],
        });
        outcome = { ok: delivered.ok, detail: delivered.body };
        if (!delivered.ok) throw new Error(JSON.stringify(delivered.value));
      } finally {
        outcomes.push(outcome);
      }
    });
    await run(session);
  } finally {
    standIn.receiveWebhooks(undefined);
    await standIn.stop();
  }
}

export function call(session: Session, name: string, path: string, args: Json[]): Promise<CallResult> {
  return session.context.call(name, session.app, { path: [path], args });
}

/** A call to the subscriptions interface, which the module implements next to the payment one. */
export function subscription(session: Session, name: string, path: string, args: Json[]): Promise<CallResult> {
  return session.context.call(name, session.app, { interface: "@antelopejs/interface-subscriptions", path: [path], args });
}

let counter = 0;

/** A fresh idempotency key or reference, unique within the process. */
export function fresh(prefix: string): string {
  counter += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${counter}`;
}

/** The name and message of the error a call threw, or `null` when it returned. */
export function thrown(result: CallResult): Json {
  return [pick(result.json, "error", "name") ?? null, pick(result.json, "error", "message") ?? null];
}

export function answered(result: CallResult): Check {
  return { name: "the call through core answered", pass: result.ok, detail: result.ok ? "ok" : `${result.body}` };
}

/** `equal` that ignores key order; an absent value, also inside an array, reads as `null`. */
export function same(name: string, actual: Json | undefined | (Json | undefined)[], expected: Json | undefined): Check {
  return equal(name, canonical(Array.isArray(actual) ? tuple(...actual) : actual), canonical(expected));
}

/** One request to the stand-in as a client of Mollie would send it, under an API key; the answer is parsed JSON, or `null` when the body is empty. */
export async function wire(base: string, method: string, path: string, key: string, body?: Json): Promise<{ status: number; json: Json }> {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(new URL(path, base), init);
  const raw = await response.text();
  return { status: response.status, json: raw === "" ? null : parseJson(raw) };
}

/** What the stand-in holds for a payment, read with the account's API key and not through the module. */
export async function paymentAtProvider(session: Session, id: string, key: string = PRIMARY_KEY): Promise<Json> {
  return (await wire(session.base, "GET", `/v2/payments/${id}`, key)).json;
}

/** The calls the stand-in has answered for an account so far, oldest first. */
export function callsOf(session: Session, key: string = PRIMARY_KEY): RecordedCall[] {
  return session.standIn.account(key).requests.flatMap((entry) => {
    const recorded = toCall(parseJson(JSON.stringify(entry)));
    return recorded === null ? [] : [recorded];
  });
}

/** The calls to one endpoint, oldest first. */
export function callsTo(session: Session, method: string, path: string, key: string = PRIMARY_KEY): RecordedCall[] {
  return callsOf(session, key).filter((entry) => entry.method === method && entry.path === path);
}

/** Moves a payment to `status` at the provider, as the payer or the bank would, and lets the stand-in notify the module's webhook. */
export function settle(session: Session, id: string, status: MolliePayment["status"], key: string = PRIMARY_KEY): void {
  const payment = session.standIn.account(key).payments.get(id);
  if (payment === undefined) throw new Error(`the stand-in holds no payment ${id}`);
  session.standIn.settle(key, payment, status);
}

const WAIT_TIMEOUT_MS = 2000;
const POLL_MS = 5;
const QUIET_MS = 100;

function requestCount(session: Session): number {
  return [PRIMARY_KEY, SECOND_KEY].reduce((total, key) => total + session.standIn.account(key).requests.length, 0);
}

/** `settle`, then waits until the module has handled the webhook delivery it causes and has sent Mollie nothing for 100 ms, so work the delivery started reaches the stand-in before the next read. The whole wait stops after two seconds; the check passes when the module answered that delivery without an error. */
export async function settleDelivered(session: Session, id: string, status: MolliePayment["status"], key: string = PRIMARY_KEY): Promise<Check> {
  const before = session.delivered.get(id)?.length ?? 0;
  settle(session, id, status, key);
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  const delivery = () => session.delivered.get(id)?.[before];
  while (delivery() === undefined && Date.now() < deadline) await pause(POLL_MS);
  let seen = requestCount(session);
  let quietSince = Date.now();
  while (Date.now() - quietSince < QUIET_MS && Date.now() < deadline) {
    await pause(POLL_MS);
    const now = requestCount(session);
    if (now !== seen) [seen, quietSince] = [now, Date.now()];
  }
  const handled = delivery();
  return {
    name: "the module handled the webhook delivery of the settled payment",
    pass: handled?.ok === true,
    detail: handled === undefined ? `no delivery for ${id} ${status} within ${WAIT_TIMEOUT_MS} ms` : `${id} ${status}: ${handled.detail.slice(0, 300)}`,
  };
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** A customer at the provider with one saved card: a first payment that the payer completes, read back through `ListPaymentMethods`. */
export async function savedMethod(session: Session, name: string, provider: string | null = null): Promise<{ customer: string; method: string; first: string }> {
  const customer = await call(session, `${name}: CreateCustomer`, "CreateCustomer", [{ email: `${fresh("payer")}@merchant.invalid`, name: "Verify Payer" }, fresh("key"), provider]);
  const customerId = text(pick(customer.value, "id"));
  const first = await call(session, `${name}: first payment`, "CreatePayment", [
    { amount: EUR, reference: fresh("first"), customer: customerId, savePaymentMethod: true, returnUrl: RETURN_URL },
    fresh("key"),
    provider,
  ]);
  const firstId = text(pick(first.value, "id"));
  settle(session, firstId, "paid", provider === null ? PRIMARY_KEY : SECOND_KEY);
  const methods = await call(session, `${name}: ListPaymentMethods`, "ListPaymentMethods", [customerId, provider]);
  return { customer: customerId, method: text(pick(methods.value, 0, "id")), first: firstId };
}

/** A paid payment: a saved method charged off-session and settled. */
export async function paidPayment(session: Session, name: string, extra: Record<string, Json> = {}): Promise<string> {
  const saved = await savedMethod(session, name);
  const charged = await call(session, `${name}: off-session charge`, "CreatePayment", [
    { amount: { value: 2500, currency: "EUR" }, reference: fresh("paid"), paymentMethod: saved.method, offSession: true, ...extra },
    fresh("key"),
    null,
  ]);
  const id = text(pick(charged.value, "id"));
  settle(session, id, "paid");
  return id;
}
