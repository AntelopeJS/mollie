---
covers:
  - src/implementations/payment/payments.ts
  - src/implementations/payment/mapping.ts
  - src/implementations/payment/errors.ts
  - src/implementations/payment/index.ts
  - src/mollie/amounts.ts
  - src/mollie/fields.ts
  - src/mollie/guards.ts
  - src/mollie/ids.ts
  - src/mollie/json.ts
  - src/mollie/metadata.ts
  - src/mollie/resources.ts
  - src/mollie/types.ts
  - src/accounts.ts
  - src/implementations/payment/instruments.ts
  - src/implementations/payment/webhooks.ts
  - src/implementations/shared/subscription-of-payment.ts
  - src/implementations/subscriptions/calendar.ts
  - src/implementations/subscriptions/errors.ts
  - src/implementations/subscriptions/events.ts
  - src/implementations/subscriptions/mapping.ts
  - src/implementations/subscriptions/records.ts
  - src/index.ts
  - src/mollie/client.ts
  - src/mollie/errors.ts
docs:
  - README.md
  - docs/2.payments.md
journeys:
  - pay-redirect
  - pay-settles
  - pay-amounts
  - pay-idempotent
  - pay-not-found
---

# Payments

An application module charges with `CreatePayment` and reads the payment back with `GetPayment`.

## Sub-features

- `pay-redirect`: a payment with no method becomes one open Mollie payment with the amount as a decimal string, the reference and the webhook, and reads back `requires_action` with Mollie's checkout link.
- `pay-settles`: once the payer pays, the payment reads `succeeded` with the amount captured; a payment Mollie declines reads `failed` with a normalised reason and Mollie's own; a payment that expires reads `canceled`.
- `pay-amounts`: amounts reach Mollie with the currency's decimals: two for euros and forints, none for yen.
- `pay-idempotent`: the same key returns the first payment and leaves one at Mollie; a new key is a new payment.
- `pay-not-found`: an unknown id and a malformed one are both `PaymentNotFoundError`, the second without a request.

## How to get to it (user POV)

- A module that imports `@antelopejs/interface-payment` and calls `CreatePayment(request, idempotencyKey, provider?)`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" payments
```

## Gotchas

- The Mollie side is the module's own stand-in (`src/test/stand-in`, built to `dist/test/stand-in`), so a feature proves agreement with its reading of Mollie's documentation, not with the live service; see [sandbox](sandbox.md).
