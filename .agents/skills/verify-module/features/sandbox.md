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

What only the real Mollie can show: that its test mode accepts the requests the client builds and settles the payment the module creates.

## Sub-features

- `request-contract`: a payment request reaches Mollie at the configured API URL as one POST with the payment as its JSON body, under the account's key and the caller's idempotency key, and nothing goes out under the other account's key.
- `sandbox-live`: a payment created through core reaches Mollie's test mode (`mode: test`) under the operator's key, sends the payer to Mollie's own checkout, and reads back `succeeded` once the browser payer pays it there. It runs only against Mollie's test mode, and is NOT VERIFIED on any other Mollie side.

## How to get to it (user POV)

- A merchant who runs the module with a `test_` key.

## Driving it with antelopejs-verify

```bash
node_modules/.bin/antelopejs-verify journey <run> sandbox
```

Load `MOLLIE_API_KEY` before `new`, as [A live run](README.md#a-live-run) shows.

## Gotchas

- The `mollie-requests` step of `sandbox-live` lists the creating request as the proxy recorded it (method, path, idempotency key) next to Mollie's answer.
- The browser payer needs `pnpm exec playwright install chromium-headless-shell` once per machine.
