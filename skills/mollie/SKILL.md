---
name: mollie
description: The AntelopeJS Mollie module — implements @antelopejs/interface-payment and, on Mollie's own subscriptions, @antelopejs/interface-subscriptions. Use when wiring "@antelopejs/mollie" into a project, configuring its API key, webhook URL or extra accounts, writing the route that passes Mollie's webhooks to VerifyWebhook, or debugging a Mollie payment that stays pending, a hold that was captured at once, a capture that came back pending, a missing refund event, or a subscription whose status, period or renewal looks wrong.
category: antelopejs-module
tags: [payment, subscriptions, mollie, webhooks, recurring, antelopejs]
---

# mollie

Implements the payment and subscriptions interfaces on Mollie. Consumers code against `@antelopejs/interface-payment` and `@antelopejs/interface-subscriptions` (see their skills); this module is what you wire.

## Wiring

```ts
modules: {
  payments: {
    source: { type: "package", package: "@antelopejs/mollie" },
    config: { apiKey: "test_…", webhookUrl: "https://shop.example.org/payments/mollie" },
  },
}
```

No other module is needed. To use `@antelopejs/payment-subscriptions` for subscriptions instead, add `disabledExports: ["@antelopejs/interface-subscriptions"]` to this entry.

## Config

| Field             | Required | Meaning                                                                                                                                                     |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`          | Yes      | `test_…` or `live_…`                                                                                                                                        |
| `webhookUrl`      | No       | Public route calling `VerifyWebhook`; without it no event is ever raised                                                                                    |
| `accounts`        | No       | `{ name: { apiKey, webhookUrl } }`, chosen by the `provider` argument                                                                                       |
| `apiUrl`          | No       | Defaults to `https://api.mollie.com`                                                                                                                        |
| `settleTimeoutMs` | No       | How long `CapturePayment` waits for Mollie to apply a capture; default 10000, `0` does not wait; a finite number, 0 or more, or the module refuses to start |

## The webhook route

Pass the raw body and the headers to `VerifyWebhook`. Mollie posts `id=tr_…`, unsigned; the module reads the payment back and builds the event from that read only. `WebhookVerificationError` → answer 403. A `PaymentError` (Mollie unreachable) or a subscription handler that throws → answer 5xx, Mollie retries. `undefined` → answer 200.

## Facts to reason from when debugging

- **Payer-present payments are redirects**: `requires_action` with Mollie's checkout URL. A checkout session's id is its payment's id.
- **The hosted page language** comes from the checkout `locale`: a language gets the region Mollie offers it in (`fr` is `fr_FR`, `en` is `en_US`, `pt-BR` is `pt_PT`), and a language Mollie does not offer (`ja`, `zh`, …) or `auto` sends none, so Mollie picks from the browser. The table is in `docs/2.payments.md`.
- **Off-session charges come back `pending`**; the outcome (`succeeded`, `authorized`, `failed`) arrives later through the webhook. In test mode nothing settles until someone submits the test-mode page.
- **Saved methods are mandates**, id `cst_…:mdt_…`, belonging to one customer. A saved card is listed once its payment reads `succeeded`: `GetPayment` and `VerifyWebhook` wait up to 5 seconds for Mollie to turn the mandate valid. Detaching one revokes the mandate, and Mollie cancels the subscriptions that charge it.
- **`authorizeOnly`** only for cards, Klarna, Billie, Riverty, Vipps, MobilePay, PayPal, Billink; anything else is refused before Mollie is called.
- **No `refund.*` or `dispute.opened` events**: a Mollie delivery names a payment, never its refund or chargeback. Read refunds with `GetRefund`.
- **Idempotency keys last one hour** at Mollie; `RefundPayment`, `CapturePayment` and `CreateSubscription` find their earlier result by key at any time.
- **Captures settle after the call**: Mollie answers a capture `pending` and applies it about a second later. `CapturePayment` waits up to `settleTimeoutMs`, then returns `succeeded`, or `pending` with `amountCaptured` already set; `GetPayment` reads a payment with a capture in flight the same way. A read that fails after Mollie accepted the capture also returns `pending`; a capture Mollie fails rejects with `PaymentError` `capture_failed`. Mollie takes one capture per authorization, so a second capture under another key, or `CancelPayment`, while a capture is in flight or applied is `InvalidPaymentStateError` and never reaches Mollie.
- **State errors come from the module reading the payment first.** A Mollie 422 is a `PaymentError`: it also means a suspended account. A capture Mollie refuses with 422 is read again, and a capture another caller made meanwhile turns it into `InvalidPaymentStateError`.
- **Subscriptions**: the first period is charged by `CreateSubscription` and not retried if it fails; Mollie's schedule starts one period later and Mollie retries its own renewals five times, then cancels. Dates are Europe/Amsterdam days; trial ends and anchors round up to the next midnight. `period_end` cancels at Mollie at once and is reported as running until the period ends, with no event when it does. `now` after `period_end` records the early end in the customer's metadata, one call at a time within a process; two processes ending one customer's subscriptions early at once can lose one, which then reports its scheduled end. Subscriptions not created by this module are invisible to it.
- **A failed `CreateSubscription` must be replayed with its key**: Mollie may already hold the subscription and will charge it. Replay once the call has failed, not while it runs: an overlapping replay can cancel the subscription the call returns if the first charge fails in between.

## Not in this module

Mollie Connect, OAuth, next-gen (signed) webhooks, Orders API, payment links, terminals, chargeback handling beyond what `GetPayment` shows.
