/**
 * Reader's view of SubscriptionCreation.tla for /statechart: one region for
 * what Mollie holds and one per CreateSubscription call under the key.
 */

/**
 * @typedef {{ status: string; refused: boolean; first: boolean }} Sub
 * @typedef {{ sub: number; status: string; created: string }} Charge
 * @typedef {{
 *   subs: Record<string, Sub>;
 *   charges: Record<string, Charge>;
 *   pc: Record<string, string>;
 *   answer: Record<string, string>;
 * }} State
 */

const CALL_NAMES = new Map([
  ["c1", "The first call"],
  ["c2", "A replay"],
  ["c3", "Another replay"],
]);

const WHERE = new Map([
  ["idle", "Not sent"],
  ["postSub", "Found no subscription"],
  ["get", "Has the subscription"],
  ["earlier", "Read it uncharged"],
  ["postCharge", "Found no first charge"],
  ["patchFirst", "Holds an open first charge"],
  ["patchRefused", "Holds a failed first charge"],
  ["cancel", "Cancelling it as refused"],
]);

const ANSWERS = new Map([
  ["ok", "Returned the subscription"],
  ["refused", "Rejected, payment refused"],
  ["error", "Failed"],
]);

/** @param {Sub} sub */
function describe(sub) {
  const billing = sub.status === "active" ? "a billing subscription" : "a canceled subscription";
  return sub.refused ? `${billing} the module hides` : billing;
}

/** @param {State} v */
function mollie(v) {
  const subs = Object.values(v.subs ?? {});
  const charges = Object.values(v.charges ?? {});
  const held = subs.length === 0 ? "No subscription" : subs.map(describe).join(" and ");
  if (charges.length === 0) return held;
  const statuses = charges.map((charge) => charge.status).join(" and ");
  return `${held}, ${charges.length === 1 ? "first charge" : "first charges"} ${statuses}`;
}

/**
 * One region for Mollie, one per call.
 *
 * @param {State} v
 */
export function state(v) {
  /** @type {Record<string, string | undefined>} */
  const regions = { Mollie: mollie(v) };
  const answers = new Map(Object.entries(v.answer));
  for (const [call, pc] of Object.entries(v.pc)) {
    regions[CALL_NAMES.get(call) ?? call] = pc === "done" ? ANSWERS.get(answers.get(call) ?? "") : WHERE.get(pc);
  }
  return regions;
}

/**
 * @param {State} from
 * @param {State} to
 */
const grew = (from, to) => Object.keys(to.subs ?? {}).length > Object.keys(from.subs ?? {}).length;

/** @type {Record<string, (who: string, next: string, from: State, to: State) => string>} */
const STEPS = {
  List: (who, next) => (next === "get" ? `${who} finds the subscription by its key` : `${who} finds none`),
  PostSub: (who, next, from, to) => {
    if (next === "get") return grew(from, to) ? `${who} creates the subscription` : `Mollie replays the create for ${who}`;
    return grew(from, to) ? `${who} creates the subscription, its answer is lost` : `${who}'s create fails`;
  },
  Get: (who, next) =>
    next === "cancel" ? `${who} reads it refused` : next === "done" ? `${who} reads it charged` : `${who} reads it uncharged`,
  Earlier: (who, next) =>
    next === "postCharge" ? `${who} finds no first charge` : `${who} finds the first charge ${next === "patchRefused" ? "failed" : "open"}`,
  PostCharge: (who, next) =>
    next === "patchRefused" ? `${who} charges, Mollie declines` : next === "patchFirst" ? `${who} charges` : `${who}'s charge answer is lost`,
  PatchFirst: (who) => `${who} records the first charge`,
  PatchRefused: (who) => `${who} marks the subscription refused`,
  Cancel: (who) => `${who} cancels the refused subscription`,
  Fail: (who) => `a request of ${who} fails`,
};

/**
 * The arrow label, as the merchant would see it happen.
 *
 * @param {string} action
 * @param {State} from
 * @param {State} to
 */
export function step(action, from, to) {
  if (action === "Expire") return "Mollie forgets an idempotency key";
  if (action === "LateFailure") return "the open first charge fails";
  const label = STEPS[action];
  const before = new Map(Object.entries(from.pc));
  const after = new Map(Object.entries(to.pc));
  const call = [...after.keys()].find((key) => before.get(key) !== after.get(key));
  if (!label || call === undefined) return null;
  return label(CALL_NAMES.get(call) ?? call, after.get(call) ?? "", from, to);
}

export const title = "CreateSubscription under one idempotency key, with crashes, retries and Mollie's one-hour key memory";
