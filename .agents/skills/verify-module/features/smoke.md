---
covers:
docs:
  - README.md
  - docs/5.testing.md
journeys:
  - module-dev
  - pay-through-stand-in
---

# Smoke

The fixed journey every verdict runs: load the module as `local`, create one payment and read it back.

## Sub-features

- `module-dev` is the pack's journey: the project answers, the consumer loads both implemented interfaces, Ctrl+C exits 130.
- `pay-through-stand-in`: one `CreatePayment` reaches the stand-in and the payment reads `succeeded` once Mollie settles it.

## How to get to it (user POV)

- A project with `@antelopejs/mollie` and a module that imports `@antelopejs/interface-payment`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" smoke
```

## Gotchas

- The smoke feature covers no glob, so it never marks a file as mapped.
- The Mollie side is the module's own stand-in (`src/test/stand-in`, built to `dist/test/stand-in`), so a feature proves agreement with its reading of Mollie's documentation, not with the live service; see [sandbox](sandbox.md).
