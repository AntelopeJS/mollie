import { RegisterHandler, UnregisterHandler } from "./events";

export * from "./changes";
export { CreateSubscription } from "./creation";

export const SubscriptionEvents = {
  register: RegisterHandler,
  unregister: UnregisterHandler,
};
