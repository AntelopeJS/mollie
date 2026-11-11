---
covers:
docs:
  - README.md
  - docs/5.testing.md
journeys:
  - module-dev
  - pay-read-back
---

# Smoke

The fixed journey every verdict runs: load the module as `local`, create one payment and read it back.

## Sub-features

- `module-dev` is the pack's journey: the project answers, the consumer loads both implemented interfaces, Ctrl+C exits 130.
- `pay-read-back`: one `CreatePayment` reaches Mollie and the payment reads `succeeded` once the payer pays it.

## How to get to it (user POV)

- A project with `@antelopejs/mollie` and a module that imports `@antelopejs/interface-payment`.

## Driving it with antelopejs-verify

```bash
node_modules/.bin/antelopejs-verify journey <run> smoke
```

## Gotchas

- The smoke feature covers no glob, so it never marks a file as mapped.
- With `MOLLIE_API_KEY` set to a test key these journeys run against Mollie's test mode, as [A live run](README.md#a-live-run) describes; without it every journey is NOT VERIFIED. `saas` caps the whole run, `module-dev` included.
