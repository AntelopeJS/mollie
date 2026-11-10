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

- With `MOLLIE_API_KEY` set to a test key these journeys run against Mollie's test mode, as [A live run](README.md#a-live-run) describes; without it every journey is NOT VERIFIED.
- `account-selection` needs two Mollie accounts: live only when `MOLLIE_SECOND_API_KEY` names a second test account, on the stand-in otherwise. With one key the proxy still records each account's calls apart, which `unknown-provider` reads.
- In a live run `bad-key`'s key belongs to no account, so the proxy forwards it unchanged and the refusal is Mollie's own.
