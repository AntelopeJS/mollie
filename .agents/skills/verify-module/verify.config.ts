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
    data: null,
    format: null,
    contract: null,
    outbound: null,
    exposure: null,
    publish: null,
  },
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
