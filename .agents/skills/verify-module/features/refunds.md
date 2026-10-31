---
covers:
  - src/implementations/payment/refunds.ts
docs:
  - README.md
  - docs/2.payments.md
journeys:
  - refund-flow
  - refund-replay
---

# Refunds

An application module refunds all or part of a paid payment with `RefundPayment` and reads it with `GetRefund`.

## Sub-features

- `refund-flow`: a partial refund, then a refund with no amount that takes what is left, are recorded at Mollie and read back; a third is refused.
- `refund-replay`: replaying a refund with its key returns the original and refunds once.

## How to get to it (user POV)

- A module that calls `RefundPayment(request, idempotencyKey, provider?)` on a paid payment.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" refunds
```

## Gotchas

- The Mollie side is the module's own stand-in (`src/test/stand-in`, built to `dist/test/stand-in`), so a feature proves agreement with its reading of Mollie's documentation, not with the live service; see [sandbox](sandbox.md).
