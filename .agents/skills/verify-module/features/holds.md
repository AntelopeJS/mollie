---
covers:
  - src/implementations/payment/payments.ts
  - src/implementations/payment/instruments.ts
docs:
  - README.md
  - docs/2.payments.md
journeys:
  - hold-capture
  - hold-release
  - hold-refused
---

# Holds

An application module holds funds with `authorizeOnly`, then captures in part with `CapturePayment` or releases with `CancelPayment`.

## Sub-features

- `hold-capture`: an authorize-only charge is `pending` until Mollie authorizes it, then captures in part and records the capture at Mollie; a replayed key returns the capture, another key is a state error.
- `hold-release`: cancelling an authorization releases it, cancelling an open payment cancels it, cancelling again returns it, and a settled payment cannot be cancelled.
- `hold-refused`: an authorize-only payment on a method Mollie would capture at once is refused before any request.

## How to get to it (user POV)

- A module that calls `CreatePayment` with `authorizeOnly` on a saved card, then `CapturePayment` or `CancelPayment`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" holds
```

## Gotchas

- The Mollie side is the module's own stand-in (`src/test/stand-in`, built to `dist/test/stand-in`), so a feature proves agreement with its reading of Mollie's documentation, not with the live service; see [sandbox](sandbox.md).
