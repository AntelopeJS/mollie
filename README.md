# @antelopejs/mollie

<div align="center">
<a href="https://www.npmjs.com/package/@antelopejs/mollie"><img alt="NPM version" src="https://img.shields.io/npm/v/@antelopejs/mollie.svg?style=for-the-badge&labelColor=000000"></a>
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/@antelopejs/mollie.svg?style=for-the-badge&labelColor=000000"></a>
<a href="https://discord.gg/sjK28QHrA7"><img src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000" alt="Discord"></a>
</div>

A Mollie payment module for AntelopeJS. It implements the generic payment interface, and the subscriptions interface on Mollie's own subscriptions.

## Installation

```bash
ajs project modules add @antelopejs/mollie
```

## Interfaces

This module implements two interfaces. Each is installed separately to maintain modularity and minimize dependencies.

| Name          | Install command                        |                                                                        |
| ------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| Payment       | `ajs module imports add payment`       | [Documentation](https://github.com/AntelopeJS/interface-payment)       |
| Subscriptions | `ajs module imports add subscriptions` | [Documentation](https://github.com/AntelopeJS/interface-subscriptions) |

It needs no other module: no Redis, no database, no API module.

## Configuration

```json
{
  "apiKey": "test_…",
  "webhookUrl": "https://shop.example.org/payments/mollie"
}
```

- `apiKey` (required): a Mollie API key. `test_…` keys work against Mollie's test mode.
- `webhookUrl`: the public URL of your route that passes Mollie's deliveries to `VerifyWebhook`. It is sent with every payment and subscription this module creates. Without it Mollie calls nothing, no payment event is ever raised, and no subscription renewal is ever reported. Mollie refuses `localhost`.
- `accounts`: further Mollie accounts, keyed by the name callers pass as the interfaces' trailing `provider` selector, each with its own `apiKey` and `webhookUrl`. The top-level account is the default.
- `apiUrl`: where the Mollie API lives. Defaults to `https://api.mollie.com`; the test suite points it at a local stand-in.

Mollie Connect and OAuth are not supported: API keys only.

## Webhooks

Mollie's classic webhooks, which are what Mollie recommends for payments, post `id=tr_…` and nothing else, unsigned. `VerifyWebhook` reads that payment back from Mollie, and every field of the event comes from that read: a delivery that names no payment, or one Mollie does not have on the account, is rejected with `WebhookVerificationError`. Mollie being unreachable is a plain `PaymentError`, so your route answers with an error and Mollie delivers again.

```ts
// in the route at webhookUrl, with the unparsed body
const event = await VerifyWebhook({ body: rawBody, headers: request.headers });
if (event) await handle(event); // undefined: a genuine delivery with nothing to report
```

Only `payment.*` events are raised. A classic delivery names a payment, never the refund or chargeback that caused it, so **`refund.succeeded`, `refund.failed` and `dispute.opened` are never raised on Mollie**: read refunds back with `GetRefund`, and a payment's refunded total with `GetPayment`. [Webhooks](./docs/3.webhooks.md) explains why.

## What differs from other providers

- **Every payer-present payment is a redirect.** `CreatePayment` and `CreateCheckoutSession` return `requires_action` with Mollie's checkout URL. A checkout session and its payment share one identifier.
- **Saved methods are Mollie mandates**, created by a payment with `savePaymentMethod` (Mollie's `first` payment). A saved method belongs to one customer. Detaching it revokes the mandate, and Mollie then cancels every subscription that charges it.
- **Off-session charges settle later.** A charge against a saved method comes back `pending`; Mollie reports `succeeded`, `authorized` or `failed` afterwards, through the webhook. A decline is a `failed` payment then, not the result of the creating call.
- **Holding funds** (`authorizeOnly`) works only for methods Mollie can capture by hand: cards, Klarna, Billie, Riverty, Vipps, MobilePay, PayPal and Billink. The module refuses any other, rather than let Mollie capture at once, and offers only those on a hosted page.
- **Idempotency keys last one hour at Mollie.** A replay within the hour returns the original result. After that, the same key is a new request, except for `CreateSubscription`, which finds its earlier result on its own.
- **`refund.*` and `dispute.opened` events are not raised.** See above.

## Subscriptions

Subscriptions are Mollie's own: Mollie holds the schedule and creates every renewal payment. [Subscriptions](./docs/4.subscriptions.md) has the full mapping. In short:

- **The first period is charged by `CreateSubscription`** as a payment carrying `antelopeSubscription`, and Mollie's own schedule starts one period later. Mollie reports a declined charge after the call returns, so the subscription is created `active` and goes `past_due` if that charge fails. That first charge is not retried.
- **Mollie schedules by calendar date.** A trial end or billing anchor is rounded up to the start of the next day in Europe/Amsterdam, and reported as that time. Periods run from one such midnight to the next.
- **Retries are Mollie's**: a failed renewal is retried up to five times, then Mollie cancels the subscription, reported as `canceled` with `endReason: "payment_failed"`.
- **Cancelling at period end** stops Mollie at once, and the subscription is reported as running until the period it paid for ends. Mollie raises nothing when that period ends, so neither does this module.
- **Events.** `subscription.created` and `subscription.canceled` are raised by the call that caused them; a handler that throws makes that call reject, and replaying its idempotency key raises the event again. `subscription.payment_succeeded` and `subscription.payment_failed` are raised from the payment webhook.
- **Only this module's subscriptions.** Subscriptions made in the dashboard or by other code on the account are not listed, read, changed or raised as events, and their charges are not marked.
- **A creation that fails must be replayed** with its idempotency key. The subscription may already exist at Mollie, and Mollie will charge it from the next period.

## Prefer the generic fallback?

Wire `@antelopejs/payment-subscriptions` and add `disabledExports: ["@antelopejs/interface-subscriptions"]` to this module's entry.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
