/**
 * Reader's view of SubscriptionCancellation.tla for /statechart: one region
 * per subscription at Mollie, one for the customer's early ends, and one per
 * CancelSubscription call. A call's key is its tuple, printed as JSON.
 */

/**
 * @typedef {{ timing: string; key: Record<string, string> }} Mark
 * @typedef {{
 *   status: Record<string, string>;
 *   mark: Record<string, Mark>;
 *   ended: Record<string, Record<string, string>>;
 *   pc: Record<string, string>;
 *   answer: Record<string, string>;
 * }} State
 */

const TIMING = new Map([
  ["period_end", "at period end"],
  ["now", "now"],
]);

const WHERE = new Map([
  ["idle", "Not sent"],
  ["patchMark", "Found it billing"],
  ["delete", "Marked it"],
  ["readCustomer", "Found it ending at period end"],
  ["patchCustomer", "Read the early ends"],
]);

const ANSWERS = new Map([
  ["ok", "Returned"],
  ["endedEarly", "Returned it ended early"],
  ["error", "Failed"],
]);

const CALL_KEY = /"1":"(\w+)","2":"(\w+)"/;

/** @param {string} key */
function callName(key) {
  const [, sub = "", timing = ""] = CALL_KEY.exec(key) ?? [];
  return `Cancel ${sub.toUpperCase()} ${TIMING.get(timing)}`;
}

/**
 * @param {State} v
 * @param {string} sub
 */
function atMollie(v, sub) {
  const status = new Map(Object.entries(v.status)).get(sub);
  if (status === "active") return "Billing";
  const mark = new Map(Object.entries(v.mark)).get(sub);
  const early = new Map(Object.entries(v.ended)).get(sub);
  const hasEarlyEnd = early !== undefined && early["1"] !== "none";
  return mark?.timing === "period_end" && !hasEarlyEnd ? "Ending at period end" : "Ended";
}

/** @param {State} v */
function earlyEnds(v) {
  const subs = Object.entries(v.ended)
    .filter(([, key]) => key["1"] !== "none")
    .map(([sub]) => sub.toUpperCase());
  return subs.length === 0 ? "No early end" : `Early ends of ${subs.join(" and ")}`;
}

/**
 * One region for the customer, one per subscription, one per call.
 *
 * @param {State} v
 */
export function state(v) {
  /** @type {Record<string, string | undefined>} */
  const regions = { Customer: earlyEnds(v) };
  for (const sub of Object.keys(v.status)) regions[`Subscription ${sub.toUpperCase()}`] = atMollie(v, sub);
  const answers = new Map(Object.entries(v.answer));
  for (const [call, pc] of Object.entries(v.pc)) {
    regions[callName(call)] = pc === "done" ? ANSWERS.get(answers.get(call) ?? "") : WHERE.get(pc);
  }
  return regions;
}

/** @type {Record<string, (who: string) => string>} */
const STEPS = {
  Load: (who) => `${who}: the module reads the subscription`,
  PatchMark: (who) => `${who}: the module marks it`,
  Delete: (who) => `${who}: Mollie cancels it`,
  ReadCustomer: (who) => `${who}: the module reads the early ends`,
  PatchCustomer: (who) => `${who}: the module writes the early ends it read, plus its own`,
  Fail: (who) => `${who}: a request fails`,
};

/**
 * The arrow label, as the merchant would see it happen.
 *
 * @param {string} action
 * @param {State} from
 * @param {State} to
 */
export function step(action, from, to) {
  const label = STEPS[action];
  const before = new Map(Object.entries(from.pc));
  const after = new Map(Object.entries(to.pc));
  const call = [...after.keys()].find((key) => before.get(key) !== after.get(key));
  return label && call !== undefined ? label(callName(call)) : null;
}

export const title = "CancelSubscription on two subscriptions of one customer: period_end, now, and now after period_end";
