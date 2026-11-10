import { join } from "node:path";

import { equal, type App, type CallResult, type Check, type JourneyContext } from "@antelopejs/tooling-configs/verify";

import { canonical, pick, text, tuple, type Json } from "./json.ts";
import { startLive, type LiveKeys } from "./live-target.ts";
import { startStandIn } from "./stand-in-target.ts";
import { ACCOUNTS, ACCOUNT_NAMES, type Account, type MollieTarget, type PaymentStatus, type RecordedCall } from "./target.ts";

export { isNumber, pick, text, tuple, type Json } from "./json.ts";
export type { Account, RecordedCall } from "./target.ts";
export type ModuleConfig = NonNullable<NonNullable<Parameters<JourneyContext["fixture"]>[0]>["moduleConfig"]>;

export const PRIMARY_KEY = ACCOUNTS.primary.key;
export const WEBHOOK_URL = ACCOUNTS.primary.webhookUrl;
export const SECOND_ACCOUNT = ACCOUNTS.second.provider;
export const RETURN_URL = "https://merchant.invalid/return";

export const EUR = { value: 1050, currency: "EUR" } as const;

const LIVE_KEY = "MOLLIE_API_KEY";
const SECOND_LIVE_KEY = "MOLLIE_SECOND_API_KEY";
const TEST_KEY_PREFIX = "test_";

/**
 * What a journey's claim needs that Mollie's test mode cannot produce, as live runs against it showed on 2026-11-10.
 * A journey that names one runs on the stand-in even when a test key is set.
 */
const TEST_MODE_LIMITS = new Map([
  ["charge-paid-at-creation", "Mollie's test mode answers an off-session card charge `paid` in the creating call, so a charge on a saved card is never `pending` and is never declined afterwards"],
  ["no-hold-on-saved-card", "Mollie's test mode answers an off-session `captureMode: manual` charge with HTTP 503 yet creates it, and its test page offers no state to authorize it with"],
  ["open-payment-not-cancelable", "no method the test account offers leaves an open payment cancelable: Mollie answers 422 to cancelling one"],
  ["refund-not-counted", "Mollie's test mode leaves the payment's `amountRefunded` at 0.00 after a refund, whether the refund reads `pending` or `refunded`"],
] as const);

/** A Mollie test-mode limitation a journey's claim runs into. */
type TestModeLimit = typeof TEST_MODE_LIMITS extends Map<infer Name, string> ? Name : never;

/** How a journey runs its session. */
export interface SessionOptions {
  /** Module config entries that replace the session's. */
  config?: ModuleConfig;
  /** The Mollie test-mode limitation the journey's claim runs into: the journey runs on the stand-in even when a test key is set. */
  standIn?: TestModeLimit;
  /** The claim needs two Mollie accounts: the journey runs live only when `MOLLIE_SECOND_API_KEY` names the second one, and on the stand-in otherwise. */
  separateAccounts?: boolean;
}

/** Where a session's Mollie requests go and why; a stand-in session that does not verify ends the journey NOT VERIFIED once its checks ran. */
type Choice = { kind: "live"; keys: LiveKeys; why: string } | { kind: "stand-in"; why: string; verifies: boolean };

function choose(context: JourneyContext, options: SessionOptions): Choice {
  const key = process.env[LIVE_KEY] ?? "";
  const second = process.env[SECOND_LIVE_KEY] ?? "";
  if (key === "") return { kind: "stand-in", verifies: false, why: `${LIVE_KEY} is unset, and only Mollie's test mode verifies a journey` };
  for (const [name, value] of [[LIVE_KEY, key], [SECOND_LIVE_KEY, second]]) {
    if (value !== "" && !value.startsWith(TEST_KEY_PREFIX)) context.notVerified(`${name} is not a Mollie test-mode key (test_…): the verify journeys never drive live payments`);
  }
  if (options.standIn !== undefined) return { kind: "stand-in", verifies: true, why: TEST_MODE_LIMITS.get(options.standIn) ?? options.standIn };
  if (options.separateAccounts === true && second === "") {
    return { kind: "stand-in", verifies: true, why: `the claim needs two Mollie accounts, and ${SECOND_LIVE_KEY} names no second test account` };
  }
  const accounts = second === "" ? `both accounts go out under ${LIVE_KEY}` : `the second account goes out under ${SECOND_LIVE_KEY}`;
  return { kind: "live", keys: { primary: key, second: second || key }, why: `${LIVE_KEY} is a test key; ${accounts}` };
}

function describe(target: MollieTarget): string {
  return target.kind === "live" ? `Mollie's test mode at https://api.mollie.com, through the recording proxy at ${target.apiUrl}` : `the module's stand-in for Mollie at ${target.apiUrl}`;
}

/** One webhook delivery the session passed to `VerifyWebhook`: whether the module answered, and what it answered. */
export interface Delivery {
  ok: boolean;
  detail: string;
}

export interface Session {
  context: JourneyContext;
  app: App;
  target: MollieTarget;
  calls: number;
  /** The outcome of each finished webhook delivery, per payment id, oldest first. */
  delivered: Map<string, Delivery[]>;
}

/** The module config for a session: the default account, a `second` one with its own key, both pointed at `apiUrl`. */
export function sessionConfig(apiUrl: string, overrides: ModuleConfig = {}): ModuleConfig {
  return {
    apiKey: ACCOUNTS.primary.key,
    apiUrl,
    webhookUrl: ACCOUNTS.primary.webhookUrl,
    accounts: { [ACCOUNTS.second.provider]: { apiKey: ACCOUNTS.second.key, webhookUrl: ACCOUNTS.second.webhookUrl } },
    ...overrides,
  };
}

/** Passes a delivery Mollie sends to `VerifyWebhook` through core, for the account whose webhook URL it reaches, and records the outcome. */
async function deliver(session: Session, url: string, body: string): Promise<void> {
  session.calls += 1;
  const id = new URLSearchParams(body).get("id") ?? "";
  const outcomes = session.delivered.get(id) ?? [];
  session.delivered.set(id, outcomes);
  let outcome: Delivery = { ok: false, detail: "the call through core did not return" };
  try {
    const delivered = await session.context.call(`webhook delivery ${session.calls}`, session.app, {
      path: ["VerifyWebhook"],
      args: [{ body: [...Buffer.from(body)], headers: { "content-type": "application/x-www-form-urlencoded" } }, url === ACCOUNTS.second.webhookUrl ? ACCOUNTS.second.provider : null],
    });
    outcome = { ok: delivered.ok, detail: delivered.body };
  } finally {
    outcomes.push(outcome);
  }
}

/**
 * Starts the Mollie side the journey runs against, loads the module in `ajs project dev` with its `apiUrl` and the session's keys, passes the webhook
 * deliveries a settled payment causes to `VerifyWebhook`, and hands both to `run`. With `MOLLIE_API_KEY` set the Mollie side is its test mode, unless
 * `options` keeps the journey on the stand-in; the evidence names the side and why, and keeps every request the module sent.
 */
export async function withSession(context: JourneyContext, run: (session: Session) => Promise<void>, options: SessionOptions = {}): Promise<void> {
  const choice = choose(context, options);
  const target = choice.kind === "live" ? await startLive(context.repo, choice.keys) : await startStandIn(context.repo);
  context.edit("mollie target", join(context.work, "mollie-target.txt"), `${describe(target)}\n${choice.why}\n`);
  try {
    const app = await context.dev("ajs-project-dev", context.fixture({ moduleConfig: sessionConfig(target.apiUrl, options.config) }));
    const session: Session = { context, app, target, calls: 0, delivered: new Map() };
    target.receiveWebhooks((url, body) => deliver(session, url, body));
    await run(session);
  } finally {
    context.edit("mollie requests", join(context.work, "mollie-requests.jsonl"), `${target.transcript()}\n`);
    await target.stop();
    const lost = target.unreachable();
    if (lost !== null) context.notVerified(`Mollie was unavailable during the journey: ${lost}`);
  }
  if (choice.kind === "stand-in" && !choice.verifies) context.notVerified(choice.why);
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

/** A request the session sends Mollie itself under the account's key, not through the module; the module's calls never include it. */
export function wire(session: Session, method: string, path: string, account: Account = "primary", body?: Json): Promise<{ status: number; json: Json }> {
  return session.target.wire(method, path, account, body);
}

/** What Mollie holds for a payment, read with the account's key and not through the module. */
export async function paymentAtProvider(session: Session, id: string, account: Account = "primary"): Promise<Json> {
  return (await wire(session, "GET", `/v2/payments/${id}`, account)).json;
}

/** The requests Mollie has received from the module under an account so far, oldest first. */
export function callsOf(session: Session, account: Account = "primary"): RecordedCall[] {
  return session.target.calls(account);
}

/** The requests to one endpoint, oldest first. */
export function callsTo(session: Session, method: string, path: string, account: Account = "primary"): RecordedCall[] {
  return callsOf(session, account).filter((entry) => entry.method === method && entry.path === path);
}

/** Whether Mollie notified a webhook as the payment settled: every payment the module creates carries the account's webhook URL, so one Mollie holds without any notifies no one. */
function notified(id: string, webhookUrl: string | null): Check {
  return {
    name: "Mollie notifies the payment's webhook as it settles",
    pass: webhookUrl !== null,
    detail: webhookUrl === null ? `Mollie holds no webhookUrl for ${id}, so settling it notified no one` : `${id} notified ${webhookUrl}`,
  };
}

/** Moves a payment to `status` at Mollie as the payer or the bank would, and lets Mollie notify the module's webhook; a payment with no webhook URL fails a check. */
export async function settle(session: Session, id: string, status: PaymentStatus, account: Account = "primary"): Promise<void> {
  const webhookUrl = await session.target.settle(id, status, account);
  if (webhookUrl !== null) return;
  const { context } = session;
  context.expect(context.edit(`no webhook for ${id}`, join(context.work, `no-webhook-${id}.txt`), `Mollie holds no webhookUrl for ${id}\n`), [notified(id, null)]);
}

const WAIT_TIMEOUT_MS = 2000;
const POLL_MS = 5;
const QUIET_MS = 100;

function requestCount(session: Session): number {
  return ACCOUNT_NAMES.reduce((total, account) => total + callsOf(session, account).length, 0);
}

/** `settle`, then waits until the module has handled the webhook delivery it causes and has sent Mollie nothing for 100 ms, so work the delivery started reaches Mollie before the next read. The wait stops two seconds after the payment settled; the check passes when the module answered that delivery without an error, and fails at once when the payment has no webhook URL. */
export async function settleDelivered(session: Session, id: string, status: PaymentStatus, account: Account = "primary"): Promise<Check> {
  const before = session.delivered.get(id)?.length ?? 0;
  const webhookUrl = await session.target.settle(id, status, account);
  if (webhookUrl === null) return notified(id, null);
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

/** A customer with one saved card: a first payment that the payer completes, read back through `ListPaymentMethods`. */
export async function savedMethod(session: Session, name: string, account: Account = "primary"): Promise<{ customer: string; method: string; first: string }> {
  const { provider } = ACCOUNTS[account];
  const customer = await call(session, `${name}: CreateCustomer`, "CreateCustomer", [{ email: `${fresh("payer")}@merchant.invalid`, name: "Verify Payer" }, fresh("key"), provider]);
  const customerId = text(pick(customer.value, "id"));
  const first = await call(session, `${name}: first payment`, "CreatePayment", [
    { amount: EUR, reference: fresh("first"), customer: customerId, savePaymentMethod: true, returnUrl: RETURN_URL },
    fresh("key"),
    provider,
  ]);
  const firstId = text(pick(first.value, "id"));
  await settle(session, firstId, "paid", account);
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
  await settle(session, id, "paid");
  return id;
}
