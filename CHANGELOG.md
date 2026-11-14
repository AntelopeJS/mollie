# Changelog

## v0.1.1

[compare changes](https://github.com/AntelopeJS/mollie/compare/v0.1.0...v0.1.1)

### 🔥 Performance

- **test:** Stop every saved card waiting out the stand-in's mandate lag ([#68](https://github.com/AntelopeJS/mollie/pull/68))

### 🩹 Fixes

- **payment:** Remember a mandate wait that ended on a read cut at the deadline ([#71](https://github.com/AntelopeJS/mollie/pull/71))

### 📖 Documentation

- **readme:** Adopt the AntelopeJS framework README style ([#67](https://github.com/AntelopeJS/mollie/pull/67))
- **readme:** Link the Docs badge to the payment interface docs ([#69](https://github.com/AntelopeJS/mollie/pull/69))

### 📦 Build

- **deps:** Cap @antelopejs ranges below the next minor ([#72](https://github.com/AntelopeJS/mollie/pull/72))

### 🤖 CI

- Run CI on Windows beside Linux ([#70](https://github.com/AntelopeJS/mollie/pull/70))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))

## v0.1.0


### 🚀 Enhancements

- Mollie implementation of the payment and subscriptions interfaces ([ef5dfaf](https://github.com/AntelopeJS/mollie/commit/ef5dfaf))

### 🔥 Performance

- **verify:** Wait for the webhook delivery instead of a fixed pause ([#37](https://github.com/AntelopeJS/mollie/pull/37))
- **webhooks:** Read a renewal's subscription once per delivery ([#47](https://github.com/AntelopeJS/mollie/pull/47))
- **payment:** Read a payment and its earlier captures or refunds together ([#48](https://github.com/AntelopeJS/mollie/pull/48))

### 🩹 Fixes

- Convert amounts by Mollie's currency table, not the runtime's ([9e306bd](https://github.com/AntelopeJS/mollie/commit/9e306bd))
- Replay captures and refunds by their key, keep early ends, keep foreign customer metadata ([eedbca1](https://github.com/AntelopeJS/mollie/commit/eedbca1))
- **verify:** Cover every file a feature's journeys reach ([#38](https://github.com/AntelopeJS/mollie/pull/38))
- **subscriptions:** Cancel a refused subscription at Mollie when its replay finds it active ([#43](https://github.com/AntelopeJS/mollie/pull/43))
- **test:** Drive Mollie's card form with Playwright in live runs ([#44](https://github.com/AntelopeJS/mollie/pull/44))
- **subscriptions:** Keep the anchor's day when Mollie reports a clamped next payment date ([#49](https://github.com/AntelopeJS/mollie/pull/49))
- **subscriptions:** Keep both early ends when two now-cancellations of one customer overlap ([#52](https://github.com/AntelopeJS/mollie/pull/52))
- **subscriptions:** Keep showing a refused subscription until Mollie has ended it ([#53](https://github.com/AntelopeJS/mollie/pull/53))
- **subscriptions:** Stop a concurrent replay from refusing a subscription another call returned ([#54](https://github.com/AntelopeJS/mollie/pull/54))
- **payment:** Report a deleted customer as not found ([#56](https://github.com/AntelopeJS/mollie/pull/56))
- **payment:** Follow Mollie's capture until it settles and refuse a second one ([#59](https://github.com/AntelopeJS/mollie/pull/59))
- **payment:** Wait for a saved card's mandate to turn valid once its payment is paid ([#57](https://github.com/AntelopeJS/mollie/pull/57))
- **payment:** Read a payment's refunded amount from its settled refunds ([#58](https://github.com/AntelopeJS/mollie/pull/58))
- **subscriptions:** Read an early end stored in the first release's shape ([#61](https://github.com/AntelopeJS/mollie/pull/61))
- **subscriptions:** Read a stored interval the module could not have written as the one Mollie bills ([#63](https://github.com/AntelopeJS/mollie/pull/63))
- **subscriptions:** Keep a customer's metadata when an early end is recorded ([#62](https://github.com/AntelopeJS/mollie/pull/62))
- **subscriptions:** Keep room in a subscription's metadata to cancel it ([#65](https://github.com/AntelopeJS/mollie/pull/65))

### 💅 Refactors

- Clean the repo with the guardrail pack ([#5](https://github.com/AntelopeJS/mollie/pull/5))
- Build defined fields and own subscriptions from narrowed values ([#11](https://github.com/AntelopeJS/mollie/pull/11))

### 📖 Documentation

- README, docs, skill, and the sources behind the stand-in ([d14ff78](https://github.com/AntelopeJS/mollie/commit/d14ff78))
- Replays of captures and refunds, forwarded renewal metadata, early-end records ([d2eab27](https://github.com/AntelopeJS/mollie/commit/d2eab27))
- The room early-end records take on a customer ([33bf31d](https://github.com/AntelopeJS/mollie/commit/33bf31d))
- A reused refund or capture key returns the earlier result ([37c7962](https://github.com/AntelopeJS/mollie/commit/37c7962))
- **agents:** Simplify repository guidance ([#2](https://github.com/AntelopeJS/mollie/pull/2))
- **github:** Send questions and ideas to Discord ([#27](https://github.com/AntelopeJS/mollie/pull/27))
- **payment:** Describe how a checkout locale sets the hosted page language ([#41](https://github.com/AntelopeJS/mollie/pull/41))
- Name the subscription metadata the module writes and the hosted hold status ([#55](https://github.com/AntelopeJS/mollie/pull/55))

### 📦 Build

- **deps:** Adopt @antelopejs/interface-payment 0.1.0 ([#8](https://github.com/AntelopeJS/mollie/pull/8))
- **deps:** Adopt @antelopejs/interface-subscriptions 0.1.0 ([#9](https://github.com/AntelopeJS/mollie/pull/9))
- **deps:** Bump @antelopejs/tooling-configs to 0.2.17 ([#14](https://github.com/AntelopeJS/mollie/pull/14))
- **deps:** Bump @antelopejs packages to the 2026-11-06 releases ([#35](https://github.com/AntelopeJS/mollie/pull/35))
- **deps:** Bump @antelopejs/tooling-configs to 0.3.4 ([#36](https://github.com/AntelopeJS/mollie/pull/36))
- **deps:** Bump @antelopejs/tooling-configs to 0.4.0 ([#39](https://github.com/AntelopeJS/mollie/pull/39))
- **deps:** Bump @antelopejs/tooling-configs to 0.5.0 ([#40](https://github.com/AntelopeJS/mollie/pull/40))
- **deps:** Bump @antelopejs/tooling-configs to 0.5.1 ([#42](https://github.com/AntelopeJS/mollie/pull/42))

### 🏡 Chore

- Adopt the guardrail pack and depend on published interfaces ([#3](https://github.com/AntelopeJS/mollie/pull/3))
- Configure Renovate with the shared preset ([#4](https://github.com/AntelopeJS/mollie/pull/4))
- Land the cleanup campaign on main ([#31](https://github.com/AntelopeJS/mollie/pull/31))
- **verify:** Remove seeded runs from the verification skill ([#32](https://github.com/AntelopeJS/mollie/pull/32))
- **ci:** Remove the weekly mutation caller ([#33](https://github.com/AntelopeJS/mollie/pull/33))
- **release:** Prepare the package for its first public release ([#66](https://github.com/AntelopeJS/mollie/pull/66))

### ✅ Tests

- **verify:** Assert what each verify journey claims ([#45](https://github.com/AntelopeJS/mollie/pull/45))
- **verify:** Run the verify journeys against Mollie's test mode ([#51](https://github.com/AntelopeJS/mollie/pull/51))
- **formal:** Check the Europe/Amsterdam calendar with generated dates ([#46](https://github.com/AntelopeJS/mollie/pull/46))
- **formal:** Model-check subscription creation and cancellation ([#50](https://github.com/AntelopeJS/mollie/pull/50))
- **formal:** Check the metadata round trip and every shape since the first release ([#60](https://github.com/AntelopeJS/mollie/pull/60))
- **formal:** Record that a subscription created with long metadata cannot be cancelled ([#64](https://github.com/AntelopeJS/mollie/pull/64))

### 🤖 CI

- Call ci-node.yml@v1 ([#34](https://github.com/AntelopeJS/mollie/pull/34))

### ❤️ Contributors

- Antony Rizzitelli ([@Upd4ting](http://github.com/Upd4ting))
- Thomasims <thomas@antelopejs.com>

