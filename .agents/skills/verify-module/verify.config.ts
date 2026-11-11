import type { VerifyConfig } from "@antelopejs/tooling-configs/verify";

import { accountJourneys } from "./journeys-accounts.ts";
import { checkoutJourneys } from "./journeys-checkout.ts";
import { customerJourneys } from "./journeys-customers.ts";
import { holdJourneys } from "./journeys-holds.ts";
import { paymentJourneys } from "./journeys-payments.ts";
import { refundJourneys } from "./journeys-refunds.ts";
import { sandboxJourneys, smokeJourneys } from "./journeys-smoke.ts";
import { PRIMARY_KEY } from "./session.ts";
import { subscriptionJourneys } from "./journeys-subscriptions.ts";
import { webhookJourneys } from "./journeys-webhooks.ts";

const config: VerifyConfig = {
  doors: {
    data: {
      globs: ["src/mollie/metadata.ts", "src/implementations/subscriptions/records.ts"],
      funnels: ["src/mollie/metadata.ts"],
      why: "everything the module keeps lives in the merchant's Mollie account, in the metadata of its payments, refunds, captures, customers and subscriptions under one key; renaming the key or changing a stored field orphans every record already written",
    },
    format: null,
    contract: {
      globs: ["package.json", "src/index.ts", "src/accounts.ts"],
      funnels: [],
      why: "the config keys (`apiKey`, `webhookUrl`, `accounts`, `apiUrl`) and the payment and subscriptions interface ranges `antelopeJs.implements` and `dependencies` declare",
    },
    outbound: {
      globs: ["src/mollie/client.ts"],
      funnels: ["src/mollie/client.ts"],
      why: "every call to Mollie leaves through this one client with the merchant's API key as a bearer token: its host, version path, headers and idempotency key decide whose account a payment is created on",
    },
    exposure: null,
    publish: {
      globs: ["package.json", ".release-it.json", "changelogen.config.json", ".github/workflows/release.yml"],
      funnels: [],
      why: "the package name and release workflow claim @antelopejs/mollie on npm",
    },
  },
  saas: {
    env: ["MOLLIE_API_KEY"],
    sandbox: "Mollie's test mode at api.mollie.com, under the merchant's test_ API key; the journeys refuse any other key",
  },
  formal: [
    {
      name: "formal-amsterdam-calendar",
      covers: ["src/implementations/subscriptions/calendar.ts", "src/implementations/subscriptions/mapping.ts"],
      files: [
        ".agents/skills/formal-amsterdam-calendar/**",
        "src/test/calendar.properties.test.ts",
        "src/test/support/calendar-model.ts",
      ],
      command: [
        "sh",
        "-c",
        "pnpm run build >/dev/null && pnpm exec ajs module test . -f dist/test/calendar.properties.test.js",
      ],
      violation: /^\s*(?:\d+\) (?:holds|finding)|[✔✓] finding) (\w+)/gm,
      passing: /^\s*[✔✓] holds (\w+)/gm,
      behaviour: { kind: "emit" },
    },
  ],
  moduleConfig() {
    return { apiKey: PRIMARY_KEY };
  },
  journeys: {
    ...paymentJourneys,
    ...holdJourneys,
    ...refundJourneys,
    ...customerJourneys,
    ...checkoutJourneys,
    ...webhookJourneys,
    ...accountJourneys,
    ...subscriptionJourneys,
    ...sandboxJourneys,
    ...smokeJourneys,
  },
};

export default config;
