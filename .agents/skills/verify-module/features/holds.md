---
covers:
  - src/implementations/payment/payments.ts
  - src/implementations/payment/instruments.ts
  - src/accounts.ts
  - src/implementations/payment/customers.ts
  - src/implementations/payment/errors.ts
  - src/implementations/payment/index.ts
  - src/implementations/payment/mapping.ts
  - src/implementations/payment/webhooks.ts
  - src/implementations/shared/subscription-of-payment.ts
  - src/implementations/subscriptions/calendar.ts
  - src/implementations/subscriptions/errors.ts
  - src/implementations/subscriptions/events.ts
  - src/implementations/subscriptions/mapping.ts
  - src/implementations/subscriptions/records.ts
  - src/index.ts
  - src/mollie/amounts.ts
  - src/mollie/client.ts
  - src/mollie/errors.ts
  - src/mollie/fields.ts
  - src/mollie/guards.ts
  - src/mollie/ids.ts
  - src/mollie/json.ts
  - src/mollie/metadata.ts
  - src/mollie/resources.ts
  - src/mollie/types.ts
docs:
  - README.md
  - skills/mollie/SKILL.md
  - docs/2.payments.md
journeys:
  - hold-capture
  - hold-release
  - hold-refused
---

# Holds

An application module holds funds with `authorizeOnly`, then captures in part with `CapturePayment` or releases with `CancelPayment`.

## Sub-features

- `hold-capture`: an authorize-only charge on a saved card is `pending` until Mollie authorizes it (a hosted card payment reads `requires_action` instead), then captures in part and records the capture at Mollie; a replayed key returns the capture, another key is a state error.
- `hold-release`: cancelling an authorization releases it, cancelling an open payment cancels it, cancelling again returns it, and a settled payment cannot be cancelled.
- `hold-refused`: an authorize-only payment on a method Mollie would capture at once is refused before any payment request; a saved SEPA mandate is read from Mollie first, to learn its method.

## How to get to it (user POV)

- A module that calls `CreatePayment` with `authorizeOnly` on a saved card, then `CapturePayment` or `CancelPayment`.

## Driving it with antelopejs-verify

```bash
node_modules/.bin/antelopejs-verify journey <run> holds
```

## Gotchas

- The Mollie side is the module's own stand-in (`src/test/stand-in`, built to `dist/test/stand-in`), so a feature proves agreement with its reading of Mollie's documentation, not with the live service; see [sandbox](sandbox.md).
