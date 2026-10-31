# What the stand-in is built from

The stand-in is an HTTP server that answers the part of Mollie's API this module uses, the way Mollie's documentation says Mollie answers. Passing against it shows the module agrees with this reading of the documentation, and nothing more. Each behaviour is listed with what it rests on:

- **spec**: Mollie's OpenAPI specification, `github.com/mollie/openapi` `specs.yaml` at `10ce28b` (2026-10-02);
- **doc**: a page on docs.mollie.com, named below by its path;
- **observed**: a response from `api.mollie.com` itself, without a key, on 2026-10-02;
- **third-party**: another project's tests against Mollie's test mode;
- **assumed**: nothing documents it; the first run against live Mollie checks it.

## Authentication and errors

| Behaviour                                                                                                          | Basis                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Error body `{status, title, detail, field?, _links.documentation}`                                                 | doc `reference/handling-errors`                                                      |
| 404 detail `No <resource> exists with token <id>.`                                                                 | doc `reference/handling-errors`                                                      |
| 422 names the offending `field`                                                                                    | doc `reference/handling-errors`                                                      |
| No `Authorization` header, or a key not shaped `test_`/`live_` + 30 characters: 400 `Invalid Authorization header` | observed                                                                             |
| A well-shaped key Mollie does not know: 401 `Missing authentication, or failed to authenticate`                    | observed, doc `reference/handling-errors`                                            |
| Each API key sees only its own records                                                                             | doc `reference/testing` (test and live data are isolated); assumed for two test keys |

## Idempotency

| Behaviour                                                                          | Basis                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Every POST honours `Idempotency-Key` for one hour; GET, PATCH and DELETE ignore it | doc `reference/api-idempotency`                               |
| A replay returns the original response with `Idempotent-Replayed: true`            | doc `reference/api-idempotency`                               |
| The same key with other parameters, or on another endpoint: 400                    | doc `reference/api-idempotency`                               |
| A failed request's error is replayed like a success                                | assumed                                                       |
| A replay racing the original: 409                                                  | doc; not modelled, the stand-in answers one request at a time |

## Payments

| Behaviour                                                                                                                                                          | Basis                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `amount` (currency, string value) and `description` are required                                                                                                   | spec                                                                                            |
| A value must carry the currency's decimals: two, none for `ISK` and `JPY`                                                                                          | doc `docs/multicurrency`, `reference/common-data-types`                                         |
| `redirectUrl` is required except for `sequenceType: recurring`                                                                                                     | spec (`redirectUrl` description)                                                                |
| A `localhost` `webhookUrl` is refused (422, `webhookUrl`)                                                                                                          | spec (`webhookUrl` description), doc `reference/webhooks`; the wording is assumed               |
| A `first` payment needs an existing customer                                                                                                                       | doc `docs/recurring-payments`; the 422 is assumed                                               |
| A `recurring` payment needs the customer and a `valid` mandate of theirs (422 `mandateId`)                                                                         | doc `docs/recurring-payments`; the 422 and field are assumed                                    |
| `captureMode: manual` with a method that cannot be held: 422                                                                                                       | assumed (the documented behaviour is for a hosted page: the payment becomes `paid`)             |
| A payment is created `open`; `expiresAt` 15 minutes later for payer-present payments                                                                               | spec (statuses; `get-payment` example: created 09:13:37, expires 09:28:37)                      |
| `isCancelable: true` while open                                                                                                                                    | assumed (the `get-payment` example shows `false` for an open iDEAL payment)                     |
| A payer-present payment links `checkout`; a recurring one links `changePaymentState` instead                                                                       | doc `reference/testing`                                                                         |
| The links are `/checkout/select-method/<token>` without a method, `/checkout/test-mode?method=<m>&token=<t>` with one                                              | spec (example hrefs)                                                                            |
| The select-method page's `button[name=method]`; the test-mode page's `input[name=final_state]` and `button[name=submit]`                                           | third-party: `piwas-21/sofra` `tests/e2e/billing-mollie.spec.ts`                                |
| Final states offered: `paid`, `failed`, `canceled`, `expired`, `open`; `paid`, `failed` for a recurring payment; `authorized` instead of `paid` for a held payment | assumed (doc `reference/testing`: "You can try out different payment statuses")                 |
| A paid `first` payment creates a `valid` mandate for the customer                                                                                                  | doc `docs/recurring-payments`                                                                   |
| …a `creditcard` or `paypal` one for those methods, a `directdebit` one for every bank method (`ideal` and the rest)                                                | doc `docs/recurring-payments`                                                                   |
| …with scopes `customer-not-present` and `customer-present`                                                                                                         | assumed                                                                                         |
| A test card mandate is a Mastercard ending 9399                                                                                                                    | doc `reference/testing` ("the test payment will default to Mastercard always"; card table)      |
| …expiring 2030-12-31                                                                                                                                               | assumed                                                                                         |
| A failed card payment's `failureReason` follows the magic amounts (€1,001.00 → `invalid_card_number`, …)                                                           | doc `reference/testing`                                                                         |
| A paid payment carries `amountRefunded` 0 and `amountRemaining` its amount                                                                                         | spec (examples)                                                                                 |
| `amountCaptured` appears on held payments only                                                                                                                     | spec ("Only available when this payment supports captures"); when exactly is assumed            |
| An authorized payment's `captureBefore` is 7 days on                                                                                                               | doc `docs/place-a-hold-for-a-payment` (Visa: 7 days)                                            |
| Capture: only an authorized payment, at most its amount (422); a partial card capture releases the rest and the payment becomes `paid`                             | spec, doc `docs/place-a-hold-for-a-payment`                                                     |
| …and the capture succeeds before the next read                                                                                                                     | assumed (doc: a capture is created `pending`)                                                   |
| Release: only an authorized payment (422), answered 202                                                                                                            | spec                                                                                            |
| …and the payment is `canceled` before the next read                                                                                                                | assumed (spec: "processed asynchronously")                                                      |
| Cancel (`DELETE /payments/{id}`): an open, cancelable payment becomes `canceled`; otherwise 422                                                                    | spec, doc `reference/cancel-payment`                                                            |
| List payments: newest first, `limit` (default 50, at most 250), `from`, `_links.next`                                                                              | doc `reference/pagination`, spec (`list-subscription-payments`: "Defaults to descending order") |
| After every status change, `id=<payment id>` is posted to the payment's `webhookUrl`                                                                               | doc `reference/webhooks`                                                                        |
| …delivered once; Mollie retries ten times over 26 hours, the stand-in does not                                                                                     | doc `reference/webhooks` (not modelled)                                                         |
| …and not for refund or chargeback changes, which Mollie also announces                                                                                             | doc `reference/webhooks` (not modelled)                                                         |

## Refunds

| Behaviour                                                                                                  | Basis                               |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `amount` is required; only a paid payment, at most `amountRemaining` (422 `amount`)                        | spec, doc `reference/create-refund` |
| A refund is created `pending`                                                                              | spec (`get-refund` example)         |
| …and counts towards `amountRefunded` (and out of `amountRemaining`) from creation                          | assumed                             |
| A refund is read under its payment                                                                         | spec                                |
| A payment's refunds and captures are listed under it, and a capture keeps the metadata it was created with | spec                                |

## Customers and mandates

| Behaviour                                                                 | Basis                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Create, read, update and delete a customer                                | spec                                                                                       |
| A deleted customer reads as 404                                           | assumed                                                                                    |
| Deleting a customer cancels its mandates and subscriptions                | spec ("All mandates and subscriptions created for this customer will be canceled as well") |
| Mandates are listed under the customer, newest first, paginated           | spec, doc `reference/pagination`                                                           |
| Only SEPA Direct Debit and PayPal mandates can be created through the API | spec (`create-mandate`); the stand-in creates SEPA ones only                               |
| Revoking a mandate cancels every subscription that charges it             | spec ("all connected subscriptions will be canceled")                                      |
| …and leaves it listed as `invalid`; revoking it again is 404              | assumed                                                                                    |
| A customer's payments are listed under the customer                       | spec                                                                                       |

## Subscriptions

| Behaviour                                                                                                                                                                | Basis                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `interval` is `N days`, `N weeks` or `N months`, at most 365 days, 52 weeks or 12 months                                                                                 | spec; the 422 is assumed                                                                                                                  |
| `startDate` is `YYYY-MM-DD`, today when omitted                                                                                                                          | spec; "today" in UTC is assumed                                                                                                           |
| `description` must be unique among the customer's active subscriptions                                                                                                   | spec (`description`); the 422 is assumed                                                                                                  |
| `mandateId` must be a valid mandate of the customer; omitted, any valid one is used                                                                                      | spec                                                                                                                                      |
| Created `active`, with `nextPaymentDate` its `startDate`                                                                                                                 | doc `docs/recurring-payments` (status follows the mandate); `nextPaymentDate` is assumed                                                  |
| A cancelled subscription cannot be updated (422)                                                                                                                         | doc `reference/update-subscription`                                                                                                       |
| Cancelling makes it `canceled` with `canceledAt`, and drops `nextPaymentDate`                                                                                            | spec ("If the subscription has been completed or canceled, this parameter will not be returned")                                          |
| Cancelling it again: 422                                                                                                                                                 | assumed                                                                                                                                   |
| A subscription's payments are listed under it, newest first                                                                                                              | spec                                                                                                                                      |
| A renewal (test control) is a `recurring` payment carrying `subscriptionId`, the subscription's mandate and `webhookUrl`, and moves `nextPaymentDate` on by one interval | doc `docs/recurring-payments` ("How do webhooks for subscriptions work?")                                                                 |
| …carrying the subscription's metadata                                                                                                                                    | spec (subscription `metadata`: "Any metadata added to the subscription will be automatically forwarded to the payments generated for it") |

## Test controls that are not Mollie

These exist only so the tests can make time pass or force an outcome. The module never calls them.

- `RenewSubscription`: what Mollie does on a `nextPaymentDate`.
- `settle`: what the test-mode page does, without the page.
- `outage`: every API call answers the given status (503, or 422 for a suspended account).
- `declinesAtCreation`: a recurring payment on that mandate is `failed` in its creating response. Nothing documents that Mollie ever does this; it exists to exercise the module's handling of a `failed` status in a creating response, which the API's schema allows.
