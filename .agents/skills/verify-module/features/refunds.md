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

- `refund-flow`: a partial refund under the caller's idempotency key, then a refund with no amount that takes what is left, are recorded at Mollie and read back; Mollie holds both and nothing left to refund; one cent more than remains is refused without a request, and so is a third.
- `refund-settled`: the payment reports the total of the refunds Mollie reports `refunded`, as the interface says ("zero until a refund settles"), and a refund still `pending` is not in it. The module sums the refunds and does not read Mollie's own `amountRefunded`, which can trail a refund's status.
- `refund-replay`: replaying a refund with its key returns the original, every refund request carries that key, and Mollie holds one refund of the whole amount.

## How to get to it (user POV)

- A module that calls `RefundPayment(request, idempotencyKey, provider?)` on a paid payment.

## Driving it with antelopejs-verify

```bash
node_modules/.bin/antelopejs-verify journey <run> refunds
```

## Gotchas

- With `MOLLIE_API_KEY` set to a test key these journeys run against Mollie's test mode, as [A live run](README.md#a-live-run) describes; without it every journey is NOT VERIFIED.
- Mollie's test mode reports the payment's `amountRefunded` at 0.00 while a refund is `pending` and moves it once the refund reads `refunded`, and can keep a refund `pending` for minutes. `refund-settled` therefore compares the payment's total with the refunds Mollie reports `refunded` when it reads them: live that is 0.00 while the refunds are `pending`, and the stand-in, which settles them, answers 25.00. It never waits for a live refund to settle.
