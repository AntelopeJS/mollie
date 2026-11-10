---
covers:
  - src/accounts.ts
  - src/index.ts
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
  - docs/1.introduction.md
journeys:
  - account-selection
  - unknown-provider
  - bad-key
---

# Accounts

An app developer configures a default Mollie account and further ones, and selects one with the trailing `provider` argument.

## Sub-features

- `account-selection`: a call that names a provider uses that account's key, and the payment lives only there.
- `unknown-provider`: a provider nobody configured is a `PaymentError` that names it (a `SubscriptionError` for the subscription functions), and no request reaches Mollie.
- `bad-key`: a key Mollie does not know is a `PaymentError` carrying Mollie's refusal message, not a missing record; the call harness returns an error's name and message only, so its `providerCode` is not observable.

## How to get to it (user POV)

- A project that configures `apiKey`, `webhookUrl` and `accounts` for `@antelopejs/mollie`.

## Driving it with antelopejs-verify

```bash
node_modules/.bin/antelopejs-verify journey <run> accounts
```

## Gotchas

- The Mollie side is the module's own stand-in (`src/test/stand-in`, built to `dist/test/stand-in`), so a feature proves agreement with its reading of Mollie's documentation, not with the live service; see [sandbox](sandbox.md).
