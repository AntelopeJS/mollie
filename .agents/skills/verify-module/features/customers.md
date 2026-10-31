---
covers:
  - src/implementations/payment/customers.ts
docs:
  - README.md
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
pnpm exec antelopejs-verify journey "$RUN" customers
```

## Gotchas

- The Mollie side is the module's own stand-in (`src/test/stand-in`, built to `dist/test/stand-in`), so a feature proves agreement with its reading of Mollie's documentation, not with the live service; see [sandbox](sandbox.md).
