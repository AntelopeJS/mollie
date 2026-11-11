# Features

One file per feature; `antelopejs-verify map` reads every file here except this one.

- [accounts](accounts.md): the default account and named ones, chosen with the trailing `provider` argument; an unknown provider and a key Mollie refuses.
- [checkout](checkout.md): `CreateCheckoutSession`, its success URL and the payer's language.
- [customers](customers.md): customers, saved methods as mandates, off-session charges and detaching a method.
- [holds](holds.md): `authorizeOnly` payments, `CapturePayment` and `CancelPayment`.
- [payments](payments.md): `CreatePayment` and `GetPayment`, amounts, settling, idempotency and unknown ids.
- [refunds](refunds.md): `RefundPayment` and `GetRefund`, partial and remaining refunds, replays.
- [sandbox](sandbox.md): the request contract the stand-in can check, and the live test mode no journey reaches.
- [smoke](smoke.md): the journeys every verdict runs, the module loading and one payment read back.
- [subscriptions](subscriptions.md): `CreateSubscription` on a saved method, and reading, changing and cancelling it.
- [webhooks](webhooks.md): `VerifyWebhook` on Mollie's classic deliveries, refusals and a Mollie outage.
