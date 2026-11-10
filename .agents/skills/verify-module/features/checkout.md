---
covers:
  - src/implementations/payment/checkout.ts
  - src/accounts.ts
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
  - hosted-session
  - session-locales
---

# Checkout

An application module sends the payer to a hosted payment page with `CreateCheckoutSession`.

## Sub-features

- `hosted-session`: a session is one Mollie payment with the success URL and the payer's language, and follows its payment as the payer pays it.
- `session-locales`: a language Mollie does not offer is left to the browser; a regional one keeps its region only when Mollie lists it (`en-GB` stays `en_GB`), otherwise it gets the region Mollie offers (`pt-BR` becomes `pt_PT`).

## How to get to it (user POV)

- A module that calls `CreateCheckoutSession(request, idempotencyKey, provider?)` and redirects the payer to `redirectUrl`.

## Driving it with antelopejs-verify

```bash
node_modules/.bin/antelopejs-verify journey <run> checkout
```

## Gotchas

- With `MOLLIE_API_KEY` set to a test key these journeys run against Mollie's test mode, as [A live run](README.md#a-live-run) describes; without it every journey is NOT VERIFIED.
