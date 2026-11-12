<a href="https://github.com/AntelopeJS/antelopejs"><img data-illustration src="./.github/readme/strip.svg" width="100%" alt="PROVIDER · MOLLIE: part of AntelopeJS, hexagonal architecture beyond your own code. A glowing button reads Star AntelopeJS."></a>

<div align="center">

# `@antelopejs/mollie`

<a href="https://www.npmjs.com/package/@antelopejs/mollie"><img data-illustration alt="npm" src="https://img.shields.io/npm/v/@antelopejs/mollie?style=for-the-badge&labelColor=000000&color=000000"></a> <a href="./LICENSE"><img data-illustration alt="License" src="https://img.shields.io/npm/l/@antelopejs/mollie?style=for-the-badge&labelColor=000000&color=000000"></a> <a href="https://discord.gg/g4pFt6eXqu"><img data-illustration alt="Discord" src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000"></a> <a href="./docs"><img data-illustration alt="Documentation" src="https://img.shields.io/badge/Docs-18181B?style=for-the-badge&color=000000"></a> <a href="https://github.com/AntelopeJS/antelopejs"><img data-illustration alt="Star AntelopeJS" src="https://img.shields.io/github/stars/AntelopeJS/antelopejs?label=Star%20AntelopeJS&style=for-the-badge&labelColor=000000&color=000000&logo=github"></a>

**The Mollie provider for AntelopeJS. It implements portable payments and subscriptions on the Mollie API.**

[Documentation](./docs) · [Interfaces](#interfaces) · [All interfaces and providers](https://github.com/AntelopeJS/antelopejs#ecosystem)

</div>

A Mollie payment module for AntelopeJS. It implements the payment interface, and it implements the subscriptions interface on Mollie's own subscriptions.

## Install

```bash
ajs project modules add @antelopejs/mollie
```

## Interfaces

This module implements two interfaces. You import each one separately, so a module that takes payments does not depend on subscriptions.

| Name          | Install command                        |                                                                        |
| ------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| Payment       | `ajs module imports add payment`       | [Documentation](https://github.com/AntelopeJS/interface-payment)       |
| Subscriptions | `ajs module imports add subscriptions` | [Documentation](https://github.com/AntelopeJS/interface-subscriptions) |

It needs no other module. It uses no Redis, no database and no API module.

## Configuration

```json
{
  "apiKey": "test_…",
  "webhookUrl": "https://shop.example.org/payments/mollie"
}
```

- `apiKey` (required) is a Mollie API key. A `test_…` key works against Mollie's test mode.
- `webhookUrl` is the public URL of your route that passes Mollie's deliveries to `VerifyWebhook`. The module sends it with every payment and subscription it creates. Without it, Mollie calls nothing, so the module raises no payment event and reports no subscription renewal. Mollie refuses a `localhost` URL.
- `accounts` holds further Mollie accounts, each with its own `apiKey` and `webhookUrl`. The key of each entry is the name that callers pass as the trailing `provider` argument of an interface function. The top-level account is the default.
- `apiUrl` is the base URL of the Mollie API. It defaults to `https://api.mollie.com`. The test suite points it at a local stand-in.
- `settleTimeoutMs` is how long `CapturePayment` waits for Mollie to apply a capture, in every account. It defaults to 10 seconds. `0` returns as soon as Mollie accepts the capture. Any value but a finite number, 0 or more, makes the module refuse to start.

The module uses API keys only. It does not support Mollie Connect or OAuth.

## Webhooks

For payments, Mollie recommends its classic webhooks. A classic delivery posts `id=tr_…` and nothing else, and Mollie does not sign it. `VerifyWebhook` reads that payment back from Mollie, and every field of the event comes from that read. A delivery that names no payment, or names a payment that Mollie does not have on the account, rejects with `WebhookVerificationError`. When Mollie cannot be reached, `VerifyWebhook` rejects with a plain `PaymentError`, so your route answers with an error and Mollie delivers again.

```ts
import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import {
  type PaymentEvent,
  VerifyWebhook,
  WebhookVerificationError,
} from "@antelopejs/interface-payment";

async function handle(event: PaymentEvent): Promise<void> {
  console.log(`${event.type} ${event.id}`);
}

// Serve this at `webhookUrl`.
createServer(async (request, response) => {
  try {
    const event = await VerifyWebhook({
      body: await buffer(request),
      headers: request.headers,
    });
    if (event) await handle(event); // undefined: a genuine delivery with nothing to report
    response.writeHead(200).end();
  } catch (error) {
    response
      .writeHead(error instanceof WebhookVerificationError ? 403 : 500)
      .end();
  }
}).listen(8080);
```

`VerifyWebhook` takes the unparsed body, so the route reads it raw. The route answers 403 only for a delivery that `VerifyWebhook` could not establish as genuine. Any other failure answers 500, and Mollie delivers again.

The module raises only `payment.*` events. A classic delivery names a payment, never the refund or chargeback that caused it, so **the module never raises `refund.succeeded`, `refund.failed` or `dispute.opened`**. Read a refund back with `GetRefund`, and a payment's refunded total with `GetPayment`. [Webhooks](./docs/3.webhooks.md) explains why.

## What differs from other providers

- **Every payer-present payment is a redirect.** `CreatePayment` and `CreateCheckoutSession` return `requires_action` with Mollie's checkout URL. A checkout session and its payment share one identifier.
- **Saved methods are Mollie mandates.** A payment with `savePaymentMethod` creates one, as Mollie's `first` payment. A saved card is listed once its payment reads `succeeded`: the module waits up to 5 seconds for Mollie to turn the mandate valid. A saved method belongs to one customer. Detaching it revokes the mandate, and Mollie then cancels every subscription that charges it.
- **Off-session charges settle later.** A charge against a saved method comes back `pending`. Mollie reports `succeeded`, `authorized` or `failed` afterwards, through the webhook. A decline is then a `failed` payment, not the result of the creating call.
- **Holding funds works only for some methods.** `authorizeOnly` needs a method that Mollie can capture by hand: cards, Klarna, Billie, Riverty, Vipps, MobilePay, PayPal and Billink. The module refuses any other method instead of letting Mollie capture at once, and a hosted page offers only those methods.
- **Captures settle after the call.** Mollie accepts a capture as `pending` and applies it about a second later. `CapturePayment` waits for that up to `settleTimeoutMs`. If Mollie has not applied the capture by then, `CapturePayment` returns the payment `pending`, with `amountCaptured` set to the amount being captured. A failed read while it waits returns `pending` the same way. A capture Mollie fails rejects with a `PaymentError` whose `providerCode` is `capture_failed`. A second capture of the same payment, or a cancellation, while the first capture is in flight or applied rejects with `InvalidPaymentStateError` before it reaches Mollie.
- **Idempotency keys last one hour at Mollie.** `RefundPayment`, `CapturePayment` and `CreateSubscription` find their earlier result by key at any time. For other calls, a replay within the hour returns the original result. After the hour, Mollie treats the same key as a new request.
- **No `refund.*` or `dispute.opened` events.** See [Webhooks](#webhooks).

## Subscriptions

Subscriptions are Mollie's own. Mollie holds the schedule and creates every renewal payment. [Subscriptions](./docs/4.subscriptions.md) has the full mapping. In short:

- **`CreateSubscription` charges the first period.** It charges a payment whose metadata names the subscription under `antelope.subscription`, and Mollie's own schedule starts one period later. Mollie reports a declined charge after the call returns, so the subscription is created `active` and goes `past_due` if that charge fails. Nothing retries that first charge.
- **Mollie schedules by calendar date.** The module rounds a trial end or a billing anchor up to the start of the next day in Europe/Amsterdam, and reports that time. A period runs from one such midnight to the next.
- **Mollie owns the retries.** Mollie retries a failed renewal up to five times, then cancels the subscription. The module reports it `canceled` with `endReason: "payment_failed"`.
- **Cancelling at period end stops Mollie at once.** The module reports the subscription as running until the end of the period it paid for. Mollie raises nothing when that period ends, so neither does this module.
- **Events.** The call that causes `subscription.created` or `subscription.canceled` raises it. A handler that throws makes that call reject, and replaying the call's idempotency key raises the event again. The payment webhook raises `subscription.payment_succeeded` and `subscription.payment_failed`.
- **About 600 bytes of subscription metadata.** Mollie keeps 1,024 bytes of metadata per subscription, and the module keeps room in them to record the first charge and a cancellation. `CreateSubscription` rejects metadata that would leave no such room with `InvalidSubscriptionRequestError`. With a reference and an idempotency key of up to 64 bytes each as JSON text, where a character JSON escapes, such as `"` or `\`, counts as its escape, 600 bytes of metadata as JSON always fit.
- **Only this module's subscriptions.** The module does not list, read, change or raise events for subscriptions made in the dashboard or by other code on the account, and it does not mark their charges.
- **Replay a failed creation with its idempotency key.** The subscription may already exist at Mollie, and Mollie will charge it from the next period. Replay once the call has failed, not while it runs: a replay that overlaps it can cancel the subscription it returns if the first charge fails in between.

## Prefer the generic fallback?

Wire `@antelopejs/payment-subscriptions`, and add `disabledExports: ["@antelopejs/interface-subscriptions"]` to this module's entry.

## Compatibility

<!-- antelopejs-docs-compat:start -->

| Package                               | Supported        | Tested with |
| ------------------------------------- | ---------------- | ----------- |
| `@antelopejs/interface-core`          | `>=0.0.5 <1.0.0` | `0.4.0`     |
| `@antelopejs/interface-payment`       | `>=0.2.0 <0.3.0` | `0.2.0`     |
| `@antelopejs/interface-subscriptions` | `>=0.1.0 <0.2.0` | `0.1.0`     |

<!-- antelopejs-docs-compat:end -->

## Part of AntelopeJS

This package belongs to [AntelopeJS](https://github.com/AntelopeJS/antelopejs), the TypeScript framework where modules depend on contracts and the application chooses the provider. The open-source back office [AntelopeJS DMS](https://github.com/AntelopeJS/dms) is built on it.

<!-- antelopejs-framework-modules:start -->

| Area         | Contracts                                                                                                                                                                                                                                                                                                                                                                                                                  | Providers                                                                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API          | [`interface-api`](https://github.com/AntelopeJS/interface-api) · [`interface-api-util`](https://github.com/AntelopeJS/interface-api-util) · [`interface-data-api`](https://github.com/AntelopeJS/interface-data-api)                                                                                                                                                                                                       | [`api`](https://github.com/AntelopeJS/api)                                                                                                                                                                      |
| Auth         | [`interface-auth`](https://github.com/AntelopeJS/interface-auth)                                                                                                                                                                                                                                                                                                                                                           | [`auth-jwt`](https://github.com/AntelopeJS/auth-jwt)                                                                                                                                                            |
| Database     | [`interface-database`](https://github.com/AntelopeJS/interface-database) · [`interface-database-decorators`](https://github.com/AntelopeJS/interface-database-decorators) · [`interface-database-catalog`](https://github.com/AntelopeJS/interface-database-catalog) · [`interface-mongodb`](https://github.com/AntelopeJS/interface-mongodb) · [`interface-rethinkdb`](https://github.com/AntelopeJS/interface-rethinkdb) | [`postgres`](https://github.com/AntelopeJS/postgres) · [`mongodb`](https://github.com/AntelopeJS/mongodb) · [`rethinkdb`](https://github.com/AntelopeJS/rethinkdb)                                              |
| Redis        | [`interface-redis`](https://github.com/AntelopeJS/interface-redis) · [`interface-redis-scheduler`](https://github.com/AntelopeJS/interface-redis-scheduler)                                                                                                                                                                                                                                                                | [`redis`](https://github.com/AntelopeJS/redis)                                                                                                                                                                  |
| Email        | [`interface-email`](https://github.com/AntelopeJS/interface-email)                                                                                                                                                                                                                                                                                                                                                         | [`nodemailer`](https://github.com/AntelopeJS/nodemailer) · [`brevo`](https://github.com/AntelopeJS/brevo)                                                                                                       |
| File storage | [`interface-file-storage`](https://github.com/AntelopeJS/interface-file-storage)                                                                                                                                                                                                                                                                                                                                           | [`file-storage-local`](https://github.com/AntelopeJS/file-storage-local) · [`file-storage-s3`](https://github.com/AntelopeJS/file-storage-s3)                                                                   |
| Payments     | [`interface-payment`](https://github.com/AntelopeJS/interface-payment) · [`interface-subscriptions`](https://github.com/AntelopeJS/interface-subscriptions) · [`interface-stripe`](https://github.com/AntelopeJS/interface-stripe)                                                                                                                                                                                         | [`stripe`](https://github.com/AntelopeJS/stripe) · **`mollie`** · [`checkout-com`](https://github.com/AntelopeJS/checkout-com) · [`payment-subscriptions`](https://github.com/AntelopeJS/payment-subscriptions) |

<!-- antelopejs-framework-modules:end -->

## License

This project is licensed under the Apache License 2.0. See the [LICENSE](LICENSE) file for details.
