import { DefinedFields } from "../../mollie/fields";
import type { MollieClient } from "../../mollie/client";
import type { MolliePayment, MolliePaymentStatus } from "../../mollie/types";

export interface PayerPolicy {
  decliningMandates: Set<string>;
}

interface Form {
  action: string;
  fields: URLSearchParams;
}

interface PaymentList {
  payments?: MolliePayment[];
}

interface PaymentPage {
  _embedded?: PaymentList;
}

interface Visit {
  url: string;
  html: string;
}

const PAYER_METHOD = "creditcard";
const MAX_STEPS = 6;
const MAX_ATTEMPTS = 3;
const PAGE = { limit: "50" };
const PAYABLE = new Set(["first", "recurring"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const FORM = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
const ATTRIBUTE = (name: string) => new RegExp(`\\b${name}="([^"]*)"`, "i");
const HIDDEN = /<input\b[^>]*type="hidden"[^>]*>/gi;

function attribute(tag: string, name: string): string | undefined {
  return ATTRIBUTE(name).exec(tag)?.[1];
}

function hiddenFields(form: string): URLSearchParams {
  const fields = new URLSearchParams();
  for (const input of form.match(HIDDEN) ?? []) {
    const name = attribute(input, "name");
    if (name) fields.set(name, attribute(input, "value") ?? "");
  }
  return fields;
}

function formFor(visit: Visit, outcome: MolliePaymentStatus): Form | undefined {
  for (const form of visit.html.match(FORM) ?? []) {
    const action = new URL(
      attribute(form, "action") ?? visit.url,
      visit.url,
    ).toString();
    const fields = hiddenFields(form);
    if (/name="final_state"/.test(form)) {
      fields.set("final_state", outcome);
      fields.set("submit", "");
      return { action, fields };
    }
    if (/name="method"/.test(form)) {
      fields.set("method", PAYER_METHOD);
      return { action, fields };
    }
  }
  return undefined;
}

export class TestPayer {
  private readonly attempts = new Map<string, number>();
  private readonly cookies = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private sweeping: Promise<void> | undefined;
  readonly errors: string[] = [];

  constructor(
    private readonly client: MollieClient,
    private readonly policy: PayerPolicy,
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
  }

  outcomeFor(payment: MolliePayment): MolliePaymentStatus {
    if (payment.sequenceType === "first") return "paid";
    if (this.policy.decliningMandates.has(payment.mandateId ?? ""))
      return "failed";
    return payment.captureMode === "manual" ? "authorized" : "paid";
  }

  private async sweep(): Promise<void> {
    const listed = await this.client
      .request<PaymentPage>({
        method: "GET",
        path: "/payments",
        query: PAGE,
      })
      .catch(() => undefined);
    for (const payment of listed?._embedded?.payments ?? []) {
      await this.consider(payment);
    }
  }

  private async consider(payment: MolliePayment): Promise<void> {
    const link =
      payment._links.checkout?.href ?? payment._links.changePaymentState?.href;
    const tries = this.attempts.get(payment.id) ?? 0;
    const isPayable =
      payment.status === "open" &&
      PAYABLE.has(payment.sequenceType) &&
      link &&
      tries < MAX_ATTEMPTS;
    if (!isPayable) return;
    this.attempts.set(payment.id, tries + 1);
    try {
      await this.complete(link, this.outcomeFor(payment));
    } catch (error) {
      this.errors.push(
        `${payment.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async complete(start: string, outcome: MolliePaymentStatus): Promise<void> {
    let visit = await this.fetchPage(start, "GET");
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const form = formFor(visit, outcome);
      if (!form) return;
      if (form.fields.has("final_state")) {
        await this.send(form.action, "POST", form.fields);
        return;
      }
      visit = await this.fetchPage(form.action, "POST", form.fields);
    }
    throw new Error(
      `The test-mode checkout at ${start} did not reach a final state`,
    );
  }

  private async fetchPage(
    url: string,
    method: string,
    form?: URLSearchParams,
  ): Promise<Visit> {
    let current = url;
    let response = await this.send(current, method, form);
    while (REDIRECTS.has(response.status)) {
      current = new URL(
        response.headers.get("location") ?? current,
        current,
      ).toString();
      response = await this.send(current, "GET");
    }
    return { url: current, html: await response.text() };
  }

  private async send(
    url: string,
    method: string,
    form?: URLSearchParams,
  ): Promise<Response> {
    const host = new URL(url).host;
    const response = await fetch(url, {
      method,
      redirect: "manual",
      headers: DefinedFields({
        Cookie: this.cookies.get(host),
        "Content-Type": form ? "application/x-www-form-urlencoded" : undefined,
      }),
      body: form?.toString(),
    });
    const cookies = response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0]);
    if (cookies.length > 0) this.cookies.set(host, cookies.join("; "));
    return response;
  }
}
