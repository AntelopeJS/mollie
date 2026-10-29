import { NotFound } from "./responses";
import type { Account, StandInResponse } from "./state";
import { type PaymentHooks, PaymentOf, Transition } from "./payments";
import type { MolliePayment, MolliePaymentStatus } from "../../mollie/types";

export interface PageRequest {
  account: Account;
  hooks: PaymentHooks;
  token: string;
  form: URLSearchParams;
}

const PAGE_METHODS = ["creditcard", "ideal", "paypal"];
const HTML = { "Content-Type": "text/html; charset=utf-8" };

function finalStates(payment: MolliePayment): MolliePaymentStatus[] {
  if (payment.captureMode === "manual")
    return ["authorized", "failed", "canceled", "expired"];
  if (payment.sequenceType === "recurring") return ["paid", "failed"];
  return ["paid", "failed", "canceled", "expired", "open"];
}

function isFinalState(
  states: MolliePaymentStatus[],
  value: string,
): value is MolliePaymentStatus {
  return states.some((state) => state === value);
}

function page(title: string, body: string): StandInResponse {
  return {
    status: 200,
    headers: HTML,
    body: `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`,
  };
}

function PaymentOfToken(request: PageRequest): MolliePayment {
  const id = request.account.tokens.get(request.token);
  if (!id) throw NotFound("checkout", request.token);
  return PaymentOf(request.account, id);
}

export function SelectMethodPage(request: PageRequest): StandInResponse {
  PaymentOfToken(request);
  const buttons = PAGE_METHODS.map(
    (method) =>
      `<button type="submit" name="method" value="${method}">${method}</button>`,
  ).join("");
  return page(
    "Select a payment method",
    `<form method="post" action="/checkout/select-method/${request.token}">${buttons}</form>`,
  );
}

export function ChooseMethod(request: PageRequest): StandInResponse {
  const payment = PaymentOfToken(request);
  const method = request.form.get("method") ?? "";
  if (!PAGE_METHODS.includes(method)) {
    return page("Select a payment method", "<p>Unknown method</p>");
  }
  payment.method = method;
  return {
    status: 302,
    headers: {
      Location: `/checkout/test-mode?method=${method}&token=${request.token}`,
    },
  };
}

export function TestModePage(request: PageRequest): StandInResponse {
  const payment = PaymentOfToken(request);
  if (payment.status !== "open") {
    return page("Test mode", `<p>This payment is ${payment.status}.</p>`);
  }
  const radios = finalStates(payment)
    .map(
      (state) =>
        `<label><input type="radio" name="final_state" value="${state}">${state}</label>`,
    )
    .join("");
  return page(
    "Test mode",
    `<form method="post" action="/checkout/test-mode?token=${request.token}"><input type="hidden" name="token" value="${request.token}">${radios}<button type="submit" name="submit">Continue</button></form>`,
  );
}

export function SubmitTestMode(request: PageRequest): StandInResponse {
  const payment = PaymentOfToken(request);
  const state = request.form.get("final_state");
  if (!state || !isFinalState(finalStates(payment), state)) {
    return page("Test mode", "<p>Choose a final state.</p>");
  }
  if (state !== "open")
    Transition(request.account, request.hooks, payment, state);
  const redirect = payment.redirectUrl;
  return redirect
    ? { status: 302, headers: { Location: redirect } }
    : page("Test mode", "<p>Done.</p>");
}
