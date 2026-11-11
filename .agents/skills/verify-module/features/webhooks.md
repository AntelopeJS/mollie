---
covers:
  - src/implementations/payment/webhooks.ts
  - src/accounts.ts
  - src/implementations/payment/errors.ts
  - src/implementations/payment/index.ts
  - src/implementations/payment/instruments.ts
  - src/implementations/payment/mapping.ts
  - src/implementations/payment/payments.ts
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
  - docs/3.webhooks.md
journeys:
  - webhook-reads-back
  - webhook-refused
  - webhook-outage
---

# Webhooks

An application route passes Mollie's classic deliveries to `VerifyWebhook` and acts on the event it returns.

## Sub-features

- `webhook-reads-back`: a delivery that names a payment becomes the event of the status Mollie holds, whatever else the body claims; every delivery of one state has one event id; an expired payment is `payment.canceled`.
- `webhook-refused`: a delivery that names no payment, an unknown payment, or another account's payment is refused as unverifiable.
- `webhook-outage`: while Mollie answers 503 a call fails with a `PaymentError` carrying Mollie's message and `VerifyWebhook` rejects with it, so Mollie delivers again; once Mollie is back the same calls succeed.

## How to get to it (user POV)

- A route at the configured `webhookUrl` that calls `VerifyWebhook({ body, headers })` with the raw request.

## Driving it with antelopejs-verify

```bash
node_modules/.bin/antelopejs-verify journey <run> webhooks
```

## Gotchas

- The Mollie side is the module's own stand-in (`src/test/stand-in`, built to `dist/test/stand-in`), so a feature proves agreement with its reading of Mollie's documentation, not with the live service; see [sandbox](sandbox.md).
