---
covers:
  - src/implementations/payment/payments.ts
  - src/implementations/payment/instruments.ts
  - src/accounts.ts
  - src/implementations/payment/customers.ts
  - src/implementations/payment/errors.ts
  - src/implementations/payment/index.ts
  - src/implementations/payment/mapping.ts
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
  - hold-capture
  - hold-saved-card
  - hold-release
  - cancel-open
  - hold-refused
---

# Holds

An application module holds funds with `authorizeOnly`, then captures in part with `CapturePayment` or releases with `CancelPayment`.

## Sub-features

- `hold-capture`: an authorize-only payment with no saved method reads `requires_action`, held for manual capture at Mollie; once the payer authorizes it at Mollie's checkout nothing is captured; it captures in part under the caller's idempotency key and records the capture at Mollie; a replayed key returns the capture, another key is a state error.
- `hold-saved-card`: an authorize-only charge on a saved card is `pending` until Mollie authorizes it, held for manual capture, and then reads `authorized` with nothing captured.
- `hold-release`: cancelling an authorization releases it at Mollie, and a settled payment cannot be cancelled.
- `cancel-open`: cancelling an open payment cancels it at Mollie, and cancelling it again returns it, whatever the key.
- `hold-refused`: an authorize-only payment on a method Mollie would capture at once is refused before any request reaches Mollie; on a saved SEPA mandate it is refused after the module reads the mandate from Mollie to learn its method.

## How to get to it (user POV)

- A module that calls `CreatePayment` with `authorizeOnly`, hosted or on a saved card, then `CapturePayment` or `CancelPayment`.

## Driving it with antelopejs-verify

```bash
node_modules/.bin/antelopejs-verify journey <run> holds
```

## Gotchas

- With `MOLLIE_API_KEY` set to a test key these journeys run against Mollie's test mode, as [A live run](README.md#a-live-run) describes; without it every journey is NOT VERIFIED.
- `hold-saved-card` stays on the stand-in in a live run: Mollie's test mode answers an off-session `captureMode: manual` charge with HTTP 503 yet creates it, and its test page offers no state to authorize it.
- `cancel-open` stays on the stand-in in a live run: no method the test account offers leaves an open payment cancelable, and Mollie answers 422 to cancelling one.
- `hold-refused` needs no iDEAL on the test account, because the module refuses the iDEAL hold before calling Mollie. The SEPA mandate is created through Mollie's API.
