# Features

One file per feature; `antelopejs-verify map` reads every file here except this one.

- [accounts](accounts.md): the default account and named ones, chosen with the trailing `provider` argument; an unknown provider and a key Mollie refuses.
- [checkout](checkout.md): `CreateCheckoutSession`, its success URL and the payer's language.
- [customers](customers.md): customers, saved methods as mandates, off-session charges and detaching a method.
- [holds](holds.md): `authorizeOnly` payments, `CapturePayment` and `CancelPayment`.
- [payments](payments.md): `CreatePayment` and `GetPayment`, amounts, settling, idempotency and unknown ids.
- [refunds](refunds.md): `RefundPayment` and `GetRefund`, partial and remaining refunds, replays.
- [sandbox](sandbox.md): the request contract, and one payment taken through Mollie's test mode end to end.
- [smoke](smoke.md): the journeys every verdict runs, the module loading and one payment read back.
- [subscriptions](subscriptions.md): `CreateSubscription` on a saved method, and reading, changing and cancelling it.
- [webhooks](webhooks.md): `VerifyWebhook` on Mollie's classic deliveries, refusals and a Mollie outage.

## A live run

`verify.config.ts` declares `saas: { env: ["MOLLIE_API_KEY"] }`. Without the key, `new` records it as missing and every journey is NOT VERIFIED without running, so the verdict is never PASS. Load the merchant's Mollie test key before `new` and keep it for every `journey` call:

```bash
set -a; . ~/.local/share/antelope-sandbox/mollie.env; set +a
pnpm exec playwright install chromium-headless-shell
R=$(node_modules/.bin/antelopejs-verify new --all --base origin/main --title "<PR title>")
node_modules/.bin/antelopejs-verify doctor "$R"
node_modules/.bin/antelopejs-verify journey "$R" --plan
node_modules/.bin/antelopejs-verify clean "$R"
```

A session refuses a `MOLLIE_API_KEY` or `MOLLIE_SECOND_API_KEY` that does not start with `test_`: the journey is NOT VERIFIED and nothing is driven. With the key set, each session:

- starts a recording proxy on a free loopback port in front of `https://api.mollie.com` and points the module's `apiUrl` at it. The module's config holds the session's own two keys, one per account, so the real key never enters the fixture project or the evidence. The proxy records each request under the account whose key it carries, as the stand-in does, and forwards it under `MOLLIE_API_KEY`, or `MOLLIE_SECOND_API_KEY` for the second account when it is set. A key no account has goes out unchanged, so Mollie answers it. While a journey sets `outage`, the proxy answers every request with that status and records nothing.
- sends its own reads and writes (`wire`, `paymentAtProvider`, `subscriptionAtProvider`) to Mollie directly, so they never count as the module's calls.
- settles a payment as Mollie's test mode does: an open payment's checkout is completed by the module's live test payer (`dist/test/support/browser-checkout.js`, headless Chromium), which picks the outcome on Mollie's test-mode page. A hosted payment with no method yet gets `creditcard` through Mollie's API first, as the payer would pick a card, and a payment in another language than English gets `en_US`, the only language the payer reads. A page that fails to load is tried again while the payment stays open, 1 s, 3 s and 9 s later. A payment Mollie has already settled is left as it is. A paid first payment is waited on until its mandate turns `valid`.
- delivers `id=<payment>` to `VerifyWebhook` through core after each settle, because Mollie cannot reach a local app. Every payment the module creates carries the account's webhook URL, so a settled payment that holds none fails the check `Mollie notifies the payment's webhook as it settles`, on the stand-in too. The webhook URLs are on `example.com`, since Mollie refuses a host it cannot resolve.
- needs a payment it settles `failed` or `expired` to be created with `paymentMethod: "creditcard"`: Mollie keeps a payment created with no method `open` after a failed or expired attempt, so the payer can try another method.
- forwards each request's body bytes as the module sent them and lets Mollie judge them; it records the parsed JSON body, or the text when the body is not JSON.
- writes two evidence steps: `mollie-target`, naming the Mollie side and why, and `mollie-requests`, one JSON line per request the module sent with what Mollie answered (`id`, `status`, `mode`, `detail`, `count`).

A `journey` call made without the key, in a run `new` created with it, runs each journey on the stand-in and then ends it NOT VERIFIED, its checks recorded: a way to exercise the stand-in path, never a verdict.

When Mollie is unavailable during a journey, the journey is NOT VERIFIED, not FAIL, with the reason: Mollie answers a request of the module or of the session with a status of 500 or above, leaves one without a whole answer for 10 s, or its checkout page still fails on the network after the last attempt. The module still gets Mollie's own answer, so its handling of it stays in the evidence. The proxy's own `outage` is not Mollie's: `webhook-outage` still judges the module by it. Checks never read account-wide state such as the count of every payment: the test account is shared, so they read the calls the session recorded or the resources the journey created.

## Journeys that stay on the stand-in

A journey whose claim needs behaviour Mollie's test mode cannot produce runs on the module's stand-in (`src/test/stand-in`) even in a live run, and its `mollie-target` step names the reason. The limitations below were observed against Mollie's test mode on 2026-11-10.

| Journey                  | Mollie limitation                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `hold-saved-card`        | An off-session `captureMode: manual` card charge gets HTTP 503 yet is created, and its test page offers no state to authorize it.              |
| `cancel-open`            | No method the test account offers (`creditcard`, `paybybank`, `bancontact`, `belfius`) leaves an open payment cancelable: Mollie answers 422. |
| `saved-method-pending`   | An off-session card charge is answered `paid` by the creating call, so it is never `pending`.                                                  |
| `subscribe-declined`     | The same: a first period charged on a saved card is `paid` at once and is never declined afterwards.                                            |
| `refund-settled`         | The payment's `amountRefunded` stays 0.00 after a refund, whether the refund reads `pending` or `refunded`.                                    |
| `account-selection`      | Needs two Mollie accounts: live only when `MOLLIE_SECOND_API_KEY` names a second test account.                                                 |
| `webhook-other-account`  | The same.                                                                                                                                       |

Other limitations are worked around rather than pinned: iDEAL is not enabled on the test account, which `hold-refused` does not need because the module refuses iDEAL holds before calling Mollie; a deleted customer answers 410 where the stand-in answers 404; a first card payment reads `paid` 250 to 600 ms before its mandate turns `valid`; subscriptions renew only on their dates, which no journey reaches.
