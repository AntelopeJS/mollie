---
covers:
  - src/implementations/payment/checkout.ts
docs:
  - README.md
  - docs/2.payments.md
journeys:
  - hosted-session
  - session-locales
---

# Checkout

An application module sends the payer to a hosted payment page with `CreateCheckoutSession`.

## Sub-features

- `hosted-session`: a session is one Mollie payment with the success URL and the payer's language, and follows its payment as it settles.
- `session-locales`: a language Mollie does not offer is left to the browser, and a regional one keeps its region.

## How to get to it (user POV)

- A module that calls `CreateCheckoutSession(request, idempotencyKey, provider?)` and redirects the payer to `redirectUrl`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" checkout
```

## Gotchas

- The Mollie side is the module's own stand-in (`src/test/stand-in`, built to `dist/test/stand-in`), so a feature proves agreement with its reading of Mollie's documentation, not with the live service; see [sandbox](sandbox.md).
