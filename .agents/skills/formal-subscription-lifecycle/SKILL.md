---
name: formal-subscription-lifecycle
description: TLA+ models of @antelopejs/mollie's CreateSubscription and CancelSubscription against Mollie, checked with TLC under crashes, lost answers, retries, concurrent calls and Mollie's one-hour idempotency keys. Use when a change touches a file in its coverage record, or when a change to subscription creation, refusal, cancellation or early ends needs proof that it breaks no lifecycle rule.
---

# Formal check: subscription lifecycle

`CreateSubscription` reads the mandate, then lists the customer's subscriptions for one carrying the idempotency key, POSTs the subscription with the key, reads it back, looks for an earlier first charge, POSTs the first charge under `<key>:first-period`, then PATCHes `firstPayment`, or PATCHes `refused` and DELETEs the subscription when Mollie declines the charge. `CancelSubscription` marks and DELETEs a subscription, or, for `now` after `period_end`, records the early end in the customer's metadata, one call at a time per customer within a process. A request can fail before Mollie applies it, or after with the answer lost, the process can stop between any two requests, a caller can replay a key at any later time or while the first call still runs, and Mollie forgets a key after an hour.

The models treat each Mollie request as one step, and TLC checks every order of those steps across concurrent calls within the bounds below.

- `SubscriptionCreation.tla` models creation for one customer and one key. `SubscriptionCancellation.tla` models cancellation of the subscriptions of one customer. Each condition carries a `\* file.ts:NN` comment.
- Each spec has two configurations. `<spec>.ci.cfg` is the CI configuration and `<spec>.cfg` the full one.
- `<spec>.map.mjs` is the view for reading results with `/statechart`.

## Run it

From the repository root, with Node 24 and `pnpm install` done (the runner comes from `@antelopejs/tooling-configs/formal`):

```sh
node .agents/skills/formal-subscription-lifecycle/check.mjs          # CI configuration
node .agents/skills/formal-subscription-lifecycle/check.mjs --full   # full configuration
```

Java 11 or later comes from `$JAVA`, else `java` on PATH, else the `eclipse-temurin:21-jre` Docker image. The first run downloads TLC 1.7.4 into `~/.cache/antelopejs-formal` and checks its SHA-256. A result is replayed from that cache when nothing it reads changed; `ANTELOPEJS_FORMAL_CACHE=off` reruns TLC.

| Configuration | Creation calls | Subscriptions cancelled | States (creation, cancellation) | Wall time |
| --- | --- | --- | --- | --- |
| CI (`<spec>.ci.cfg`) | 2 | 2 | 2,944, 3,021 | about 5 s |
| Full (`<spec>.cfg`) | 3 | 3 | 142,913, 165,731 | about 9 s |

The times are uncached runs in Docker Java 21 on 32 cores; most of each is container and JVM start-up.

- Exit 0 means every rule that held still holds, and each finding still breaks with its recorded counterexample length.
- Exit 1 means a rule changed. `BROKEN` names a rule that held and now breaks, `CHANGED` a finding whose shortest counterexample changed length, `HOLDS` a finding that no longer breaks. The run stops at the first spec that changed and prints the folder holding TLC's output.
- Exit 2 means TLC or Java could not run, or the arguments were wrong.

The lines that name a broken rule match `^(?:finding|BROKEN|CHANGED|HOLDS) +(\w+)`. A rule that holds prints on the lowercase `holds` line.

## When to run it

Run `--full` when a change touches a file in the coverage record below, or this folder. `node_modules/.bin/antelopejs-verify formal <run>` runs it for such a diff and judges it by `verify-module` verdict rule 5: a changed rule fails the verdict, and the recorded findings fail it only when the diff changes what the covered code does.

## The rules

| Rule | Plain sentence | Harm when it breaks | On main |
| --- | --- | --- | --- |
| `AtMostOneSubscriptionPerKey` | At most one Mollie subscription carries the key. | Mollie bills the customer twice for one purchase. | holds |
| `AtMostOneFirstChargePerKey` | At most one first-period charge exists for the key. | The customer pays the first period twice. | holds |
| `NoHiddenActiveSubscription` | With no call running, every subscription Mollie would bill is one the module lists, reads and can cancel. | Mollie bills a subscription the app cannot see or cancel. | holds, F1 fixed |
| `RefusedIsNotBilling` | A call that rejected with `SubscriptionPaymentError` left its subscription canceled at Mollie. | The caller is told the payment was refused while Mollie keeps billing. | holds |
| `CreatedIsListed` | A call that resolved with a subscription left one the module lists. | The app grants a subscription the module then hides and Mollie cancels. | finding F2 |
| `EarlyEndNotLost` | A `now` cancellation that returned after recording an early end left that early end on the customer. | A subscription the caller ended now reads as active until its period ends. | holds; F3 fixed in #52 |

`TypeOK` holds in both specs. `check.mjs` records each finding's counterexample length for each configuration; both configurations give F2 13 states. F2 took 12 states before F1's fix, when the `refused` mark alone hid a subscription; since the fix, the subscription is hidden only once call 2's DELETE lands.

## Findings on main

Each finding was replayed at `6747973` against the stand-in through the public interface, in a scratch mocha test that wraps `globalThis.fetch` to hold, release or drop chosen Mollie requests of the module. The PR that fixes each finding brings its test.

- **F1, a billing subscription the module hides (`NoHiddenActiveSubscription`), fixed.** At `6747973`, one call finds no subscription with the key, creates one, reads it uncharged, finds no first charge and charges the first period, and Mollie declines the charge in its creating response. `refuse` PATCHes the `refused` mark (creation.ts:284); Mollie applies it, but the answer is lost, so the call rejects with `SubscriptionError` and never sends the DELETE. The subscription is active at Mollie and carries `refused`, so `ListSubscriptions` skips it and `GetSubscription` and `CancelSubscription` answer `SubscriptionNotFoundError` (changes.ts:65-66, records.ts:272); Mollie charges it on its next payment date. A DELETE that fails before Mollie applies it leaves the same state in 8 states. A replay of the key cancels it (#43, which `RefusedIsNotBilling` covers); without a replay nothing does. In the replay test, a declining mandate and a fetch wrapper that throws after the `refused` PATCH reached the stand-in made `CreateSubscription` reject, the stand-in held the subscription `active`, and `ListSubscriptions` answered `[]`. The fix hides a refused subscription only once Mollie has ended it, unless a caller cancelled it (`ShownSubscription`, records.ts:142-151), so a refusal that stops before its DELETE leaves a `past_due` subscription that the module lists, reads and cancels, and a replay still cancels it and hides it. `src/test/subscription-failures.test.ts` replays the lost answer and the failed DELETE.
- **F2, a created subscription a concurrent replay refuses (`CreatedIsListed`).** Call 1 creates the subscription and charges the first period, and the charge is `open`. Call 2, a replay of the key sent while call 1 runs, finds the subscription and reads it without `firstPayment`. Call 1 records `firstPayment` and returns the subscription. Mollie then fails the charge. Call 2's `earlierCharge` finds it failed, and `refuse` PATCHes call 2's stale copy of the metadata plus `refused` (creation.ts:182-195, 284), which drops `firstPayment`, marks the subscription refused and cancels it, and call 2 rejects with `SubscriptionPaymentError`. The caller holds a subscription that `GetSubscription` no longer finds, where docs/4.subscriptions.md promises a later failure makes it `past_due`. In the replay test, a declining mandate failed the charge after it was created `open`, the wrapper held call 1's `firstPayment` PATCH and call 2's payments read; call 1 resolved, call 2 rejected with `SubscriptionPaymentError`, and `ListSubscriptions` answered `[]` instead of call 1's subscription.
- **F3, a lost early end (`EarlyEndNotLost`), fixed in #52.** A and B are two subscriptions of one customer, each cancelled `period_end`. `now` on A reads A ending at period end and reads the customer's early ends, none. `now` on B does the same. A's call PATCHes the customer's metadata with the early ends it read plus A's (records.ts:234-243) and returns A canceled. B's call PATCHes the early ends it read plus B's, which erases A's. A reads back `active` with `cancelAtPeriodEnd: true` until its period ends, after its cancellation returned it canceled and raised `subscription.canceled`. Mollie bills neither. In the replay test, the wrapper held both customer PATCHes until both calls had read, released A's, and released B's after A's call returned `canceled`; `GetSubscription(A)` then answered `status: "active"`. `src/test/early-end-races.test.ts` replays it through the public interface. The fix keeps the early ends on the customer, since Mollie has nowhere else to keep them: it refuses any change to a canceled subscription (doc `reference/update-subscription`), an anchor or trial subscription may have no payment to carry them, and a customer update has no conditional form (doc `reference/update-customer`). So `RecordEarlyEnd` reads and writes one customer's early ends one call at a time within a process (records.ts:246-290), and `ReadCustomer` waits while another call writes. Writing, then reading the early end back and writing again when it is missing, was checked in a scratch copy of the model first and still breaks the rule in 14 states: A finds its early end and returns, then B's write from its earlier read erases it.

## Read every result with /statechart

Read each TLC result with the pstack `/statechart` skill, with `<spec>.map.mjs` as the view. Work on a copy of the spec and its view in a scratch folder outside the repo, since it writes its output next to its input. The CI configurations are above its chart budget, so it draws only their bug paths and tells each in plain words; one creation call, or one cancelled subscription, gives a full chart of about 50 states. The views hide `Settled`, the step that changes nothing once every call answered.

## Real bug or modeling error

A step order is a modeling error when the code cannot produce it, for example one request split in two, or two requests the model merged that the code sends apart. Replay the counterexample against the stand-in, one action per step, with the coverage record below:

- Wrap `globalThis.fetch` in the test: the module's client calls it per request (client.ts:109-120). Hold a request on a latch to order two calls, or let a request reach the stand-in and then throw to lose its answer.
- `StandIn().faults` fails the next matching request before it applies; `PrimaryAccount().declinesAtCreation` makes Mollie decline a first charge in its creating response; `CurrentHarness().policy.decliningMandates` makes the test payer fail an `open` charge shortly after.
- `Within(offset, work)` moves the clock past Mollie's hour so the stand-in forgets a key.

Assert only what a user observes: what the interface returns and what the stand-in holds. If the replay does not reproduce the finding, treat the model as wrong until you show it is not.

## Changing the model

- For an intended code change, edit the action that maps to that code, keep the `\* file.ts:NN` comment on each condition and update its line, then run both configurations.
- Never weaken or drop a rule to make the check pass. A fixed finding leaves `CREATION_FINDINGS` or `CANCELLATION_FINDINGS` in `check.mjs` once its replay passes. A new finding goes there with its counterexample length, and into this file with its replay.
- When you change the bounds of a `.ci.cfg`, rerun the scratch changes below on it. The CI configuration must still catch each one.
- Move the sync commit forward only after you confirm that the model describes the code at the newer commit.

## Coverage record

| Model action | Code |
| --- | --- |
| `List` | `CreateSubscription` validates and reads the mandate (creation.ts:338-354, `ChargeableMandate` 90-123), then `createAtMollie` calls `existingFor` (125-138, 164-169) |
| `PostSub` | `createAtMollie` POSTs `subscriptionBody` under the key (140-180); the client sends `Idempotency-Key` on POST only (client.ts:21, 137-140) |
| `Get` | `create` reads the subscription back (320-336); `settleFirstPeriod` branches on `refused` and `firstPayment` (299-311); `ReadOwnSubscription` (records.ts:117-135) |
| `Earlier` | `chargeFirstPeriod` calls `earlierCharge` (219-235, 243-244) |
| `PostCharge` | `chargeFirstPeriod` POSTs under `<key>:first-period` (245-264) |
| `PatchFirst` | `updateOwn` with `firstPayment` (182-195, 314), `MergeOwn` (metadata.ts:99-106), `CompleteRecord` (records.ts:294-310) |
| `PatchRefused` | `refuse` PATCHes `refused` (279-287) |
| `Cancel` | `cancelRefused` (267-277), from `refuse` (285) and from a replay (307-310) |
| `lost` in a write | Mollie applied it and the call still rejects: a lost answer, or a `subscription.created` or `subscription.canceled` handler that throws after the last write (creation.ts:359, changes.ts:147-149, events.ts:37-41) |
| `Fail` | a request that throws before Mollie applied it (client.ts:62-88, 109-120), a read that fails, or a stopped process |
| `Expire`, `LateFailure` | Mollie forgets a key after an hour (`src/test/stand-in/SOURCES.md`, Idempotency); Mollie settles the first charge after the call returned |
| `Listed` | `ShownSubscription` (records.ts:142-151), from `ListSubscriptions` (changes.ts:56-75) and `LoadRecord` (records.ts:313-327), which `GetSubscription` and `CancelSubscription` call |
| `Load` | `LoadRecord` with `earlyEndOf` (records.ts:228-244), `ToSubscription`'s ending (mapping.ts:93-110), `cancel` (changes.ts:126-151), `replayOrRefuse` and `isSameRequest` (77-96) |
| `PatchMark`, `Delete` | `cancelAtMollie` (changes.ts:98-112) |
| `ReadCustomer`, `PatchCustomer` | `endEarly` (changes.ts:114-124), `RecordEarlyEnd` with `oneAtATime` (records.ts:246-290) |
| no action | `UpdateSubscriptionPaymentMethod` (changes.ts:186-209), the webhook path (`DispatchChargeEvents`, events.ts:75-98, `SubscriptionOfPayment`) |

The sync commit is `6747973` on AntelopeJS/mollie `main`. The cancellation spec and the `records.ts` lines above describe the code at F3's fix, `dc83ee2`.

## Bounds and what is left out

The creation spec runs 2 (CI) or 3 (full) calls under one key for one customer, each with a charged start; Mollie may decline the first charge at creation and fail an open one later. Mollie refuses a POST whose description an active subscription of the customer has (the same request has the same description), and stores that 422 under the key. A key can be forgotten only once every call that was running when Mollie stored it has ended: a call is a few requests of at most 30 s each. The cancellation spec runs 2 (CI) or 3 (full) charged subscriptions of one customer, each with one `period_end` and one `now` cancellation under distinct keys, sent once each, while the current period lasts, all in one module instance. A pass covers these bounds only.

The models leave out:

- trial and anchor starts, which never charge or refuse, and request validation and the mandate read, which write nothing.
- the 250-payment page `earlierCharge` reads: the model sees every charge of the customer, and docs/4.subscriptions.md states the bound.
- a replay whose body differs from the first request's, such as a `startDate` across an Amsterdam midnight, which Mollie answers 400 while it remembers the key; Mollie's 409 to a replay racing its original; a request Mollie applies after the client timed out.
- retries of a cancellation under the same key: two attempts each grow the cancellation spec past 4.5 million states.
- a cancellation racing a creation's metadata PATCH on the same subscription, which PATCHes a whole metadata object from an earlier read, as in F2, and is not checked.
- a second instance of the module, or other code holding the API key, writing the customer's metadata while `RecordEarlyEnd` runs. `oneAtATime` orders the calls of one process only, and Mollie has no conditional update, so such a write can still erase an early end.
- subscriptions made outside the module, events, webhooks and Mollie's own cancellations.

## Confirm the check can fail

Each scratch change below was made in `src/`, mirrored in a scratch copy of the model, run with `check.mjs` in both configurations and with `subscriptions.test.js` and `subscription-failures.test.js` against the stand-in, then removed. The table holds the runs after F1's fix. Both configurations gave the same lines unless a cell names each.

| Scratch change in the code, and the model edit | `check.mjs`, CI and full | Stand-in suite |
| --- | --- | --- |
| Drop the `existingFor` lookup (creation.ts:168-169): `List` always goes to `PostSub` | `BROKEN AtMostOneSubscriptionPerKey: Initial -> List -> PostSub -> Get -> Earlier -> PostCharge -> PatchRefused -> Cancel -> List -> Expire -> PostSub`, `CHANGED CreatedIsListed: 14 states` | 2 failing |
| Drop the `earlierCharge` lookup (creation.ts:243-244): `Earlier` always goes to `PostCharge` | `BROKEN AtMostOneFirstChargePerKey: Initial -> List -> PostSub -> Get -> Earlier -> PostCharge -> List -> Get -> Earlier -> Expire -> PostCharge`, `CHANGED CreatedIsListed: 14 states` | 1 failing |
| Drop the first charge's idempotency key (creation.ts:261): `PostCharge` never finds a remembered key | `BROKEN AtMostOneFirstChargePerKey: Initial -> List -> PostSub -> Get -> Earlier -> List -> Get -> Earlier -> PostCharge -> PostCharge` | 22 passing |
| Drop the subscription's idempotency key (creation.ts:176): `PostSub` never finds a remembered key | `BROKEN AtMostOneSubscriptionPerKey: Initial -> List -> List -> PostSub -> Get -> Earlier -> PostCharge -> PatchRefused -> Cancel -> PostSub` | 22 passing |
| Drop the replay's cancel of a refused subscription (creation.ts:308, #43): `Get` answers refused | `BROKEN RefusedIsNotBilling: Initial -> List -> PostSub -> Get -> Earlier -> PostCharge -> PatchRefused -> List -> Get` | 2 failing |
| Drop `refuse`'s cancel (creation.ts:285): `PatchRefused` answers refused | `BROKEN RefusedIsNotBilling: Initial -> List -> PostSub -> Get -> Earlier -> PostCharge -> PatchRefused`, then `HOLDS CreatedIsListed` in CI and `CHANGED CreatedIsListed: 15 states` in full | 3 failing |
| Hide every refused subscription again, as before F1's fix (records.ts:146-149): `Listed` is `~refused` | `BROKEN NoHiddenActiveSubscription: Initial -> List -> PostSub -> Get -> Earlier -> PostCharge -> PatchRefused`, `CHANGED CreatedIsListed: 12 states` | 2 failing |
| Drop `oneAtATime` from `RecordEarlyEnd` (records.ts:280): `ReadCustomer` no longer waits for `Writing` | `BROKEN EarlyEndNotLost: Initial -> Load -> PatchMark -> Delete -> Load -> ReadCustomer -> Load -> PatchMark -> Delete -> Load -> ReadCustomer -> PatchCustomer -> PatchCustomer` | 1 failing (`early-end-races.test.js`) |
| Model only: Mollie may forget a key while a call that saw it stored still runs | `BROKEN AtMostOneFirstChargePerKey: Initial -> List -> PostSub -> Get -> Earlier -> List -> Get -> Earlier -> PostCharge -> Expire -> PostCharge` | not run |

Every scratch run exited 1, and `git diff --stat src` was empty afterwards. The last row shows the assumption `AtMostOneFirstChargePerKey` rests on: a call does not pause for an hour between its charge lookup and its charge POST.
