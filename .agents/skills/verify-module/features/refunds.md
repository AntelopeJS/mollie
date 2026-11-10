---
covers:
  - src/implementations/payment/refunds.ts
  - src/accounts.ts
  - src/implementations/payment/customers.ts
  - src/implementations/payment/errors.ts
  - src/implementations/payment/index.ts
  - src/implementations/payment/instruments.ts
  - src/implementations/payment/mapping.ts
  - src/implementations/payment/payments.ts
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
  - refund-flow
  - refund-settled
  - refund-replay
---

# Refunds

An application module refunds all or part of a paid payment with `RefundPayment` and reads it with `GetRefund`.

## Sub-features

- `refund-flow`: a partial refund, then a refund with no amount that takes what is left, are recorded at Mollie and read back; Mollie holds both and nothing left to refund; one cent more than remains is refused without a request, and so is a third.
- `refund-settled`: once Mollie settles the refunds, the payment reports the refunded total, as Mollie does.
- `refund-replay`: replaying a refund with its key returns the original, and Mollie holds one refund of the whole amount.

## How to get to it (user POV)

- A module that calls `RefundPayment(request, idempotencyKey, provider?)` on a paid payment.

## Driving it with antelopejs-verify

```bash
node_modules/.bin/antelopejs-verify journey <run> refunds
```

## Gotchas

- With `MOLLIE_API_KEY` set to a test key these journeys run against Mollie's test mode, as [A live run](README.md#a-live-run) describes; without it every journey is NOT VERIFIED.
- `refund-settled` stays on the stand-in in a live run: Mollie's test mode leaves the payment's `amountRefunded` at 0.00 after a refund, whether the refund reads `pending` or `refunded`. The interface reports `amountRefunded` as zero until a refund settles, so a live `GetPayment` reads 0 there.
