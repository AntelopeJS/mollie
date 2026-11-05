import { subscribeJourneys } from "./journeys-subscribe.ts";
import { subscriptionLifecycleJourneys } from "./journeys-subscription-lifecycle.ts";

export const subscriptionJourneys = {
  ...subscribeJourneys,
  ...subscriptionLifecycleJourneys,
};
