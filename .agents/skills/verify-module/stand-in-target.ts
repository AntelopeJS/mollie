import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { MollieStandIn } from "../../../src/test/stand-in/server.ts";
import { isRecord, parseJson, type Json } from "./json.ts";
import { ACCOUNTS, ACCOUNT_NAMES, send, toCall, type Account, type MollieTarget, type PaymentStatus, type RecordedCall, type WebhookReceiver, type WireAnswer } from "./target.ts";

/** The members of the module's own stand-in for Mollie (`src/test/stand-in`) that the skill drives, as the built suite exports it. */
type StandIn = Pick<MollieStandIn, "start" | "stop" | "receiveWebhooks" | "account" | "settle" | "outage">;

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
  const instance: unknown = Reflect.construct(StandInClass, [ACCOUNT_NAMES.map((account) => ACCOUNTS[account].key)]);
  if (!isStandIn(instance)) throw new Error("the stand-in does not have the members the skill drives");
  return instance;
}

const MANDATE_TIMEOUT_MS = 5000;
const MANDATE_POLL_MS = 5;

class StandInTarget implements MollieTarget {
  readonly kind = "stand-in";
  readonly apiUrl: string;
  private readonly standIn: StandIn;

  constructor(standIn: StandIn, apiUrl: string) {
    this.standIn = standIn;
    this.apiUrl = apiUrl;
  }

  get outage(): number | undefined {
    return this.standIn.outage;
  }

  set outage(status: number | undefined) {
    this.standIn.outage = status;
  }

  calls(account: Account): RecordedCall[] {
    return this.standIn.account(ACCOUNTS[account].key).requests.flatMap((entry) => {
      const recorded = toCall(parseJson(JSON.stringify(entry)));
      return recorded === null ? [] : [recorded];
    });
  }

  wire(method: string, path: string, account: Account, body?: Json): Promise<WireAnswer> {
    return send(new URL(path, this.apiUrl).href, method, ACCOUNTS[account].key, body);
  }

  /** Settles the payment, then waits for the mandate a paid first payment leaves to turn valid, as the live target does. */
  async settle(id: string, status: PaymentStatus, account: Account): Promise<string | null> {
    const { key } = ACCOUNTS[account];
    const state = this.standIn.account(key);
    const payment = state.payments.get(id);
    if (payment === undefined) throw new Error(`the stand-in holds no payment ${id}`);
    this.standIn.settle(key, payment, status);
    const deadline = Date.now() + MANDATE_TIMEOUT_MS;
    while (state.mandates.get(payment.mandateId ?? "")?.status === "pending" && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, MANDATE_POLL_MS));
    }
    return payment.webhookUrl ?? null;
  }

  receiveWebhooks(receiver: WebhookReceiver | undefined): void {
    this.standIn.receiveWebhooks(receiver);
  }

  transcript(): string {
    return ACCOUNT_NAMES.flatMap((account) => this.calls(account).map((call) => JSON.stringify({ account, ...call }))).join("\n");
  }

  unreachable(): null {
    return null;
  }

  async stop(): Promise<void> {
    this.standIn.receiveWebhooks(undefined);
    await this.standIn.stop();
  }
}

/** Starts the module's stand-in for Mollie with one account per session key. */
export async function startStandIn(repo: string): Promise<MollieTarget> {
  const standIn = await loadStandIn(repo);
  return new StandInTarget(standIn, await standIn.start());
}
