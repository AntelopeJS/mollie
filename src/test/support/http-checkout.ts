import { DefinedFields } from "../../mollie/fields";
import type { MolliePaymentStatus } from "../../mollie/types";
import type { Checkout } from "./payer";

interface Form {
  action: string;
  fields: URLSearchParams;
}

interface Visit {
  url: string;
  html: string;
}

const PAYER_METHOD = "creditcard";
const MAX_STEPS = 6;
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

/** Completes the stand-in's checkout pages with plain HTTP form posts. */
export class HttpCheckout implements Checkout {
  private readonly cookies = new Map<string, string>();

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

  async close(): Promise<void> {
    this.cookies.clear();
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
