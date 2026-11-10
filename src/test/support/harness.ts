import {
  IsMollieCustomer,
  IsMollieMandate,
  IsMolliePayment,
} from "../../mollie/resources";
import { setTimeout as delay } from "node:timers/promises";

import { MollieClient } from "../../mollie/client";
import { PaymentMethodId } from "../../mollie/ids";
import { MollieStandIn } from "../stand-in/server";
import type { AccountConfig } from "../../accounts";
import { DefinedFields } from "../../mollie/fields";
import { BrowserCheckout } from "./browser-checkout";
import { HttpCheckout } from "./http-checkout";
import { type PayerPolicy, TestPayer } from "./payer";
import { SelectTarget, type TestTarget } from "./target";
import type { MollieMandate, MolliePayment } from "../../mollie/types";

export interface Harness {
  target: TestTarget;
  apiUrl?: string;
  standIn?: MollieStandIn;
  client: MollieClient;
  secondClient?: MollieClient;
  payer: TestPayer;
  policy: PayerPolicy;
  chargeable: string;
  declining: string;
}

export interface ModuleConfig {
  apiKey: string;
  apiUrl?: string;
  webhookUrl?: string;
  accounts?: Record<string, AccountConfig>;
}

const STAND_IN_PAYER_INTERVAL_MS = 50;
const LIVE_PAYER_INTERVAL_MS = 1_000;
const SETTLE_TIMEOUT_MS = 60_000;
const SETTLE_POLL_MS = 100;
const RETURN_URL = "https://merchant.invalid/return/provisioning";
const PROVISIONING_AMOUNT = { currency: "EUR", value: "1.00" };
export const SECOND_ACCOUNT = "second";
export const SUBSCRIPTIONS_SUITE_METHOD = "creditcard";

declare global {
  /** The harness the test config starts, read by the compiled suites. */
  var antelopejsMollieTestHarness: Harness | undefined;
}

async function waitForStatus(
  client: MollieClient,
  id: string,
): Promise<MolliePayment> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let payment = await client.request(
    {
      method: "GET",
      path: `/payments/${id}`,
    },
    IsMolliePayment,
  );
  while (payment.status === "open" && Date.now() < deadline) {
    await delay(SETTLE_POLL_MS);
    payment = await client.request(
      {
        method: "GET",
        path: `/payments/${id}`,
      },
      IsMolliePayment,
    );
  }
  return payment;
}

async function validMandate(
  client: MollieClient,
  customerId: string,
): Promise<MollieMandate | undefined> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const mandates = await client.list(
      `/customers/${customerId}/mandates`,
      "mandates",
      IsMollieMandate,
    );
    const valid = mandates.find((candidate) => candidate.status === "valid");
    if (valid || Date.now() >= deadline) return valid;
    await delay(SETTLE_POLL_MS);
  }
}

async function ProvisionCardMandate(
  client: MollieClient,
  label: string,
): Promise<string> {
  const customer = await client.request(
    {
      method: "POST",
      path: "/customers",
      body: {
        name: `Conformance ${label}`,
        email: `${label}@merchant.invalid`,
      },
    },
    IsMollieCustomer,
  );
  const first = await client.request(
    {
      method: "POST",
      path: "/payments",
      body: {
        amount: PROVISIONING_AMOUNT,
        description: `Saves the ${label} test card`,
        sequenceType: "first",
        method: "creditcard",
        customerId: customer.id,
        redirectUrl: RETURN_URL,
      },
    },
    IsMolliePayment,
  );
  const settled = await waitForStatus(client, first.id);
  if (settled.status !== "paid") {
    throw new Error(
      `Provisioning the ${label} card: first payment ${first.id} is ${settled.status}`,
    );
  }
  const mandate = await validMandate(client, customer.id);
  if (!mandate)
    throw new Error(`Provisioning the ${label} card left no valid mandate`);
  return PaymentMethodId(customer.id, mandate.id);
}

async function startTarget(
  target: TestTarget,
): Promise<Pick<Harness, "apiUrl" | "standIn">> {
  if (!target.standIn) return {};
  const standIn = new MollieStandIn(
    [target.apiKey, target.secondApiKey ?? ""].filter(Boolean),
  );
  return { standIn, apiUrl: await standIn.start() };
}

export async function StartHarness(
  environment: Record<string, string | undefined>,
): Promise<Harness> {
  const target = SelectTarget(environment);
  const { apiUrl, standIn } = await startTarget(target);
  const client = new MollieClient({ apiKey: target.apiKey, apiUrl });
  const policy: PayerPolicy = { decliningMandates: new Set() };
  const payer = new TestPayer(
    client,
    policy,
    target.standIn ? new HttpCheckout() : new BrowserCheckout(),
    target.standIn ? STAND_IN_PAYER_INTERVAL_MS : LIVE_PAYER_INTERVAL_MS,
  );
  payer.start();
  const chargeable = await ProvisionCardMandate(client, "chargeable");
  const declining = await ProvisionCardMandate(client, "declining");
  policy.decliningMandates.add(declining.split(":")[1]);
  const harness: Harness = {
    target,
    apiUrl,
    standIn,
    client,
    payer,
    policy,
    chargeable,
    declining,
    ...DefinedFields({
      secondClient: target.secondApiKey
        ? new MollieClient({ apiKey: target.secondApiKey, apiUrl })
        : undefined,
    }),
  };
  globalThis.antelopejsMollieTestHarness = harness;
  return harness;
}

export function CurrentHarness(): Harness {
  const harness = globalThis.antelopejsMollieTestHarness;
  if (!harness)
    throw new Error(
      "The Mollie test harness was not started by the test config",
    );
  return harness;
}

export async function StopHarness(): Promise<void> {
  const harness = globalThis.antelopejsMollieTestHarness;
  if (!harness) return;
  await harness.payer.stop();
  for (const error of harness.payer.errors) {
    process.stderr.write(`test payer: ${error}\n`);
  }
  for (const delivery of harness.standIn?.deliveries ?? []) {
    if (delivery.outcome === "failed") {
      process.stderr.write(
        `stand-in webhook ${delivery.body} failed: ${delivery.error}\n`,
      );
    }
  }
  await harness.standIn?.stop();
  delete globalThis.antelopejsMollieTestHarness;
}

export function ModuleConfigFor(harness: Harness): ModuleConfig {
  const { target, apiUrl } = harness;
  return {
    apiKey: target.apiKey,
    ...DefinedFields({
      apiUrl,
      webhookUrl: target.webhookUrl,
      accounts: target.secondApiKey
        ? { [SECOND_ACCOUNT]: { apiKey: target.secondApiKey } }
        : undefined,
    }),
  };
}

export function SuiteEnvironment(harness: Harness) {
  return {
    ANTELOPE_PAYMENT_TEST_METHOD: harness.chargeable,
    ANTELOPE_PAYMENT_TEST_METHOD_DECLINED: harness.declining,
    ANTELOPE_PAYMENT_TEST_CURRENCY: "EUR",
    MOLLIE_TEST_TARGET: harness.target.mode,
    ...DefinedFields({
      ANTELOPE_SUBSCRIPTIONS_TEST_EVENTS: harness.target.standIn
        ? "1"
        : undefined,
    }),
  };
}
