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
  - saved-method-pending
---

# Customers

An application module keeps customers and their saved methods, and charges a saved method without the payer.

## Sub-features

- `customer-lifecycle`: a customer is created with its email, name and metadata, reads back, and is gone after deletion: `GetCustomer` is `CustomerNotFoundError` and Mollie no longer has it.
- `saved-method-charge`: a payment with `savePaymentMethod` leaves a mandate Mollie holds valid; an off-session charge on it goes to Mollie as a recurring payment on that customer and mandate and reads `succeeded`; a method belongs to one customer; detaching revokes the mandate.
- `saved-method-pending`: an off-session charge on a saved card is `pending`, not decided by the call, until Mollie settles it.

## How to get to it (user POV)

- A module that calls `CreateCustomer`, `CreatePayment` with `savePaymentMethod`, `ListPaymentMethods` and `DetachPaymentMethod`.

## Driving it with antelopejs-verify

```bash
node_modules/.bin/antelopejs-verify journey <run> customers
```

## Gotchas

- With `MOLLIE_API_KEY` set to a test key these journeys run against Mollie's test mode, as [A live run](README.md#a-live-run) describes; without it every journey is NOT VERIFIED.
- Mollie and the stand-in answer a deleted customer with 410 Gone; `customer-lifecycle` expects 410 from Mollie and `CustomerNotFoundError` from the module.
- `saved-method-pending` stays on the stand-in in a live run: Mollie's test mode answers an off-session card charge `paid` in the creating call.
