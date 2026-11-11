import assert from "node:assert/strict";

import {
  CANCELLATION_TIMINGS,
  SUBSCRIPTION_INTERVALS,
} from "@antelopejs/interface-subscriptions";

import type { OwnSubscription } from "../../implementations/subscriptions/records";
import { IsNumberValue, IsTextValue } from "./metadata-model";

const STARTS = ["anchor", "charged", "trial"];
const OWN_FIELDS = [
  "reference",
  "createKey",
  "interval",
  "intervalCount",
  "start",
  "firstPayment",
  "refused",
  "cancel",
];
const CANCEL_FIELDS = ["timing", "key", "endsAt"];
/**
 * Asserts that an own subscription record a reader returned has, in every
 * field it holds, the type its interface documents: the cancellation mark's
 * timing among the interface's timings included.
 */
export function AssertOwnTypes(own: OwnSubscription): void {
  assert.ok(Object.keys(own).every((field) => OWN_FIELDS.includes(field)));
  assert.ok(IsTextValue(own.reference));
  assert.ok(SUBSCRIPTION_INTERVALS.includes(own.interval));
  assert.ok(IsNumberValue(own.intervalCount));
  assert.ok(STARTS.includes(own.start));
  for (const text of [own.createKey, own.firstPayment, own.refused]) {
    assert.ok(text === undefined || IsTextValue(text));
  }
  const { cancel } = own;
  if (cancel === undefined) return;
  assert.ok(
    Object.keys(cancel).every((field) => CANCEL_FIELDS.includes(field)),
  );
  assert.ok(
    CANCELLATION_TIMINGS.includes(cancel.timing),
    `cancel.timing reads as ${JSON.stringify(cancel.timing)}`,
  );
  assert.ok(IsTextValue(cancel.key));
  assert.ok(cancel.endsAt === undefined || IsNumberValue(cancel.endsAt));
}
