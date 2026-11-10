---
covers:
  - src/mollie/client.ts
  - src/mollie/errors.ts
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
  - src/mollie/fields.ts
  - src/mollie/guards.ts
  - src/mollie/ids.ts
  - src/mollie/json.ts
  - src/mollie/metadata.ts
  - src/mollie/resources.ts
  - src/mollie/types.ts
docs:
  - README.md
  - docs/5.testing.md
journeys:
  - request-contract
  - sandbox-live
---

# Sandbox

What only the real Mollie can show: that the requests the client builds are accepted by Mollie's test mode.

## Sub-features

- `request-contract`: a payment request reaches the stand-in, which accepts the two session keys and records the request under the key it carried, and is accepted: the one leg of the contract a stand-in can check.
- `sandbox-live`: always NOT VERIFIED. No journey reaches Mollie's test mode: it needs the merchant's `test_` API key. A verdict that requires this feature therefore reads NOT VERIFIED, never PASS. The smoke feature leaves it out so a diff that touches no client code is judged on the stand-in journeys.

## How to get to it (user POV)

- A merchant who runs the module with a `test_` key.

## Driving it with antelopejs-verify

```bash
node_modules/.bin/antelopejs-verify journey <run> sandbox
```

## Gotchas

- The Mollie side is the module's own stand-in (`src/test/stand-in`, built to `dist/test/stand-in`), so a feature proves agreement with its reading of Mollie's documentation, not with the live service; see [sandbox](sandbox.md).
