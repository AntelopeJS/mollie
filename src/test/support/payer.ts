import { IsMolliePaymentPage } from "../../mollie/resources";
import type { MollieClient } from "../../mollie/client";
import type { MolliePayment, MolliePaymentStatus } from "../../mollie/types";

export interface PayerPolicy {
  decliningMandates: Set<string>;
}

/** Drives one checkout page flow to the chosen final state. */
export interface Checkout {
  complete(start: string, outcome: MolliePaymentStatus): Promise<void>;
  close(): Promise<void>;
}

const MAX_ATTEMPTS = 3;
const PAGE = { limit: "50" };
const PAYABLE = new Set(["first", "recurring"]);

export class TestPayer {
  private readonly attempts = new Map<string, number>();
  private readonly completing = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private sweeping: Promise<void> | undefined;
  readonly errors: string[] = [];

  constructor(
    private readonly client: MollieClient,
    private readonly policy: PayerPolicy,
    private readonly checkout: Checkout,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.sweeping ??= this.sweep().finally(() => {
        this.sweeping = undefined;
      });
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.sweeping;
    await Promise.all(this.completing.values());
    await this.checkout.close();
  }

  outcomeFor(payment: MolliePayment): MolliePaymentStatus {
    if (payment.sequenceType === "first") return "paid";
    if (this.policy.decliningMandates.has(payment.mandateId ?? ""))
      return "failed";
    return payment.captureMode === "manual" ? "authorized" : "paid";
  }

  private async sweep(): Promise<void> {
    const listed = await this.client
      .request(
        {
          method: "GET",
          path: "/payments",
          query: PAGE,
        },
        IsMolliePaymentPage,
      )
      .catch(() => undefined);
    for (const payment of listed?._embedded?.payments ?? []) {
      this.consider(payment);
    }
  }

  private consider(payment: MolliePayment): void {
    const link =
      payment._links.checkout?.href ?? payment._links.changePaymentState?.href;
    const tries = this.attempts.get(payment.id) ?? 0;
    const isPayable =
      payment.status === "open" &&
      PAYABLE.has(payment.sequenceType) &&
      link &&
      tries < MAX_ATTEMPTS &&
      !this.completing.has(payment.id);
    if (!isPayable) return;
    this.attempts.set(payment.id, tries + 1);
    this.completing.set(
      payment.id,
      this.checkout
        .complete(link, this.outcomeFor(payment))
        .catch((error: unknown) => {
          this.errors.push(
            `${payment.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => this.completing.delete(payment.id)),
    );
  }
}
