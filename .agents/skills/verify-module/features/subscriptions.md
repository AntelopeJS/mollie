---
covers:
  - src/implementations/subscriptions/calendar.ts
  - src/implementations/subscriptions/changes.ts
  - src/implementations/subscriptions/creation.ts
  - src/implementations/subscriptions/errors.ts
  - src/implementations/subscriptions/events.ts
  - src/implementations/subscriptions/index.ts
  - src/implementations/subscriptions/mapping.ts
  - src/implementations/subscriptions/records.ts
  - src/implementations/shared/subscription-of-payment.ts
  - src/accounts.ts
  - src/implementations/payment/customers.ts
  - src/implementations/payment/errors.ts
  - src/implementations/payment/index.ts
  - src/implementations/payment/instruments.ts
  - src/implementations/payment/mapping.ts
  - src/implementations/payment/payments.ts
  - src/implementations/payment/webhooks.ts
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
  - docs/4.subscriptions.md
journeys:
  - subscribe-charged
  - subscribe-replay
  - subscribe-schedule
  - subscribe-refused
  - subscribe-declined
  - cancel-now
  - cancel-period-end
  - change-method
  - subscribe-own
---

# Subscriptions

An application module subscribes a customer's saved method to a plan with `CreateSubscription`, and reads, changes and cancels it.

## Sub-features

- `subscribe-charged`: a subscription is one Mollie subscription with the first period charged at once as a recurring payment, and reads back active.
- `subscribe-replay`: one idempotency key makes one subscription and one first charge; a new key a new subscription.
- `subscribe-schedule`: a trial or anchor defers the first charge to the next Amsterdam day, a year is twelve months at Mollie, and a period Mollie cannot bill is refused before any request.
- `subscribe-refused`: another customer's method and a malformed one are invalid requests and create nothing.
- `subscribe-declined`: a first charge Mollie declines afterwards leaves the subscription `past_due` and is not retried.
- `cancel-now`: cancelling now ends the subscription at Mollie with the reason `requested`; a replayed key returns it, another key is a state error.
- `cancel-period-end`: cancelling at period end stops Mollie at once and reports the subscription as running until its period ends; cancelling now after that ends it early and the early end stays.
- `change-method`: a subscription moves to another saved method of the same customer; another customer's method and a subscription set to end are refused.
- `subscribe-own`: a subscription made at Mollie outside the module is not listed, found or cancelled by it.

## How to get to it (user POV)

- A module that imports `@antelopejs/interface-subscriptions` and calls `CreateSubscription(request, idempotencyKey, provider?)` with a customer and a saved method.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" subscriptions
```

## Gotchas

- The Mollie side is the module's own stand-in (`src/test/stand-in`, built to `dist/test/stand-in`), so a feature proves agreement with its reading of Mollie's documentation, not with the live service; see [sandbox](sandbox.md).
- Subscription events are raised to handlers registered in the module's own process, which a call through core cannot register, so no journey reaches them; their ids and triggers are judged from `docs/4.subscriptions.md` and the module's own tests.
- Renewals are created by Mollie on its dates, with no test clock, so no journey reaches a renewal.
