---
covers:
  - src/implementations/payment/customers.ts
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
  - customer-lifecycle
  - saved-method-charge
---

# Customers

An application module keeps customers and their saved methods, and charges a saved method without the payer.

## Sub-features

- `customer-lifecycle`: a customer is created with its email, name and metadata, reads back, and is gone after deletion.
- `saved-method-charge`: a payment with `savePaymentMethod` leaves a mandate the customer is charged on off-session; a method belongs to one customer; detaching revokes the mandate.

## How to get to it (user POV)

- A module that calls `CreateCustomer`, `CreatePayment` with `savePaymentMethod`, `ListPaymentMethods` and `DetachPaymentMethod`.

## Driving it with antelopejs-verify

```bash
node_modules/.bin/antelopejs-verify journey <run> customers
```

## Gotchas

- The Mollie side is the module's own stand-in (`src/test/stand-in`, built to `dist/test/stand-in`), so a feature proves agreement with its reading of Mollie's documentation, not with the live service; see [sandbox](sandbox.md).
