import assert from "node:assert/strict";

import { FromMollieAmount, ToMollieAmount } from "../mollie/amounts";
import { Lookup } from "../mollie/fields";
import { IsJsonValue, ParseJson } from "../mollie/json";
import {
  IsJsonObject,
  MergeOwn,
  ReadCallerMetadata,
  ReadOwn,
  WriteMetadata,
} from "../mollie/metadata";
import {
  ParsePaymentMethodId,
  ParseRefundId,
  ParseSubscriptionId,
  PaymentMethodId,
} from "../mollie/ids";
import {
  AddPeriods,
  DateOf,
  FormatDate,
  FromMollieInterval,
  NextDateFrom,
  ParseDate,
  StartOf,
  ToMollieInterval,
} from "../implementations/subscriptions/calendar";
import { ToSubscription } from "../implementations/subscriptions/mapping";
import type { SubscriptionRecord } from "../implementations/subscriptions/records";

const HOUR_MS = 60 * 60 * 1000;

describe("[mollie] amounts", () => {
  it("writes two decimals, and none for the zero-decimal currencies Mollie lists", () => {
    assert.deepEqual(ToMollieAmount({ value: 1050, currency: "EUR" }), {
      currency: "EUR",
      value: "10.50",
    });
    assert.deepEqual(ToMollieAmount({ value: 5, currency: "eur" }), {
      currency: "EUR",
      value: "0.05",
    });
    assert.deepEqual(ToMollieAmount({ value: 1050, currency: "JPY" }), {
      currency: "JPY",
      value: "1050",
    });
    assert.deepEqual(ToMollieAmount({ value: 1050, currency: "ISK" }), {
      currency: "ISK",
      value: "1050",
    });
    assert.deepEqual(ToMollieAmount({ value: 1050, currency: "HUF" }), {
      currency: "HUF",
      value: "10.50",
    });
    assert.deepEqual(ToMollieAmount({ value: 1050, currency: "KWD" }), {
      currency: "KWD",
      value: "1.050",
    });
  });

  it("reads them back to the same minor units", () => {
    for (const [value, currency] of [
      [1050, "EUR"],
      [0, "EUR"],
      [1050, "JPY"],
      [99, "SEK"],
    ] as const) {
      assert.deepEqual(FromMollieAmount(ToMollieAmount({ value, currency })), {
        value,
        currency,
      });
    }
  });

  it("refuses fractional or negative minor units, and a value with the wrong decimals", () => {
    assert.throws(
      () => ToMollieAmount({ value: 10.5, currency: "EUR" }),
      RangeError,
    );
    assert.throws(
      () => ToMollieAmount({ value: -1, currency: "EUR" }),
      RangeError,
    );
    assert.throws(
      () => FromMollieAmount({ value: "10.5.0", currency: "EUR" }),
      RangeError,
    );
    assert.throws(
      () => FromMollieAmount({ value: "10.50", currency: "JPY" }),
      RangeError,
    );
  });
});

describe("[mollie] identifiers", () => {
  it("pairs a mandate with its customer, and refuses anything else", () => {
    const id = PaymentMethodId("cst_abc123", "mdt_def456");
    assert.deepEqual(ParsePaymentMethodId(id), {
      parent: "cst_abc123",
      child: "mdt_def456",
    });
    for (const bad of [
      "mdt_def456",
      "cst_abc:mdt_d:x",
      "pm_card_visa",
      "cst_abc:sub_def",
      "",
    ]) {
      assert.equal(ParsePaymentMethodId(bad), undefined, bad);
    }
    assert.ok(ParseRefundId("tr_abc:re_def"));
    assert.equal(ParseRefundId("re_def"), undefined);
    assert.ok(ParseSubscriptionId("cst_abc:sub_def"));
  });
});

describe("[mollie] metadata", () => {
  it("keeps its own data apart from the caller's", () => {
    const written = WriteMetadata(
      { reference: "r-1" },
      { reference: "caller's own" },
    );
    assert.deepEqual(ReadCallerMetadata(written), {
      reference: "caller's own",
    });
    assert.deepEqual(ReadOwn(written), { reference: "r-1" });
  });

  it("reads metadata it merged into but did not write", () => {
    assert.deepEqual(
      ReadCallerMetadata({ plan: "gold", antelope: { endedEarly: {} } }),
      { plan: "gold" },
    );
  });

  it("reads metadata Mollie hands back as a JSON string", () => {
    assert.deepEqual(ReadCallerMetadata('{"order_id":"12345","count":3}'), {
      order_id: "12345",
    });
    assert.deepEqual(ReadCallerMetadata("not json"), {});
    assert.equal(ReadOwn("null"), undefined);
  });

  it("merges into its own data without touching anything else", () => {
    const merged = MergeOwn({ crm: "c-1", antelope: { a: 1 } }, { b: 2 });
    assert.deepEqual(merged, { crm: "c-1", antelope: { a: 1, b: 2 } });
  });
});

describe("[mollie] lookups", () => {
  it("answers the keys a table has and nothing for the ones it only inherits", () => {
    const table = { ideal: 1, creditcard: 2 };
    assert.equal(Lookup(table, "creditcard"), 2);
    assert.equal(Lookup(table, "paypal"), undefined);
    for (const inherited of [
      "constructor",
      "toString",
      "hasOwnProperty",
      "__proto__",
    ]) {
      assert.equal(Lookup(table, inherited), undefined, inherited);
    }
  });
});

describe("[mollie] JSON", () => {
  it("parses text to the data JSON.parse returns, an own __proto__ key included", () => {
    assert.deepEqual(ParseJson('{"a":[1,"b",null,true],"c":{"d":1.5}}'), {
      a: [1, "b", null, true],
      c: { d: 1.5 },
    });
    assert.equal(ParseJson("null"), null);
    const parsed = ParseJson('{"__proto__":{"x":1}}');
    assert.ok(IsJsonObject(parsed));
    assert.deepEqual(Object.keys(parsed), ["__proto__"]);
    assert.throws(() => ParseJson("{nope"), SyntaxError);
  });

  it("accepts only JSON data, all the way down", () => {
    assert.equal(IsJsonValue({ a: [1, { b: null }], c: "d", e: false }), true);
    assert.equal(IsJsonValue(Object.create(null)), true);
    for (const foreign of [
      undefined,
      () => 1,
      Symbol("s"),
      new Date(0),
      new Map(),
      { nested: [new Date(0)] },
      { nested: { deep: undefined } },
    ]) {
      assert.equal(IsJsonValue(foreign), false);
    }
  });
});

describe("[mollie] calendar", () => {
  it("counts months from the anchor day, clamping short months", () => {
    const anchor = ParseDate("2027-01-31");
    const month = { interval: "month" as const, count: 1 };
    assert.equal(FormatDate(AddPeriods(anchor, month, 1)), "2027-02-28");
    assert.equal(FormatDate(AddPeriods(anchor, month, 2)), "2027-03-31");
    assert.equal(
      FormatDate(AddPeriods(ParseDate("2028-01-31"), month, 1)),
      "2028-02-29",
    );
    assert.equal(FormatDate(AddPeriods(anchor, month, -1)), "2026-12-31");
    assert.equal(
      FormatDate(AddPeriods(anchor, { interval: "year", count: 1 }, 1)),
      "2028-01-31",
    );
    assert.equal(
      FormatDate(AddPeriods(anchor, { interval: "week", count: 2 }, 1)),
      "2027-02-14",
    );
  });

  it("starts each day at Amsterdam midnight, through both daylight-saving changes", () => {
    assert.equal(StartOf(ParseDate("2026-07-01")), Date.UTC(2026, 5, 30, 22));
    assert.equal(StartOf(ParseDate("2026-12-01")), Date.UTC(2026, 10, 30, 23));
    assert.equal(StartOf(ParseDate("2026-03-29")), Date.UTC(2026, 2, 28, 23));
    assert.equal(StartOf(ParseDate("2026-10-25")), Date.UTC(2026, 9, 24, 22));
    assert.equal(
      StartOf(ParseDate("2026-10-26")) - StartOf(ParseDate("2026-10-25")),
      25 * HOUR_MS,
    );
  });

  it("rounds a requested time up to the next Amsterdam day, and keeps an exact midnight", () => {
    const midnight = StartOf(ParseDate("2026-11-10"));
    assert.equal(FormatDate(NextDateFrom(midnight)), "2026-11-10");
    assert.equal(FormatDate(NextDateFrom(midnight + 1)), "2026-11-11");
    assert.equal(FormatDate(DateOf(midnight)), "2026-11-10");
  });

  it("names intervals as Mollie writes them, within Mollie's limits", () => {
    assert.equal(ToMollieInterval({ interval: "month", count: 1 }), "1 month");
    assert.equal(ToMollieInterval({ interval: "month", count: 3 }), "3 months");
    assert.equal(ToMollieInterval({ interval: "year", count: 1 }), "12 months");
    assert.equal(ToMollieInterval({ interval: "day", count: 365 }), "365 days");
    assert.throws(() => ToMollieInterval({ interval: "day", count: 366 }));
    assert.throws(() => ToMollieInterval({ interval: "week", count: 53 }));
    assert.deepEqual(FromMollieInterval("14 days"), {
      interval: "day",
      count: 14,
    });
    assert.deepEqual(FromMollieInterval("1 month"), {
      interval: "month",
      count: 1,
    });
  });
});

describe("[mollie] subscription periods", () => {
  it("starts a first charged period on the day the subscription was created, when the next month lacks that day", () => {
    const created = StartOf(ParseDate("2026-10-31")) + 10 * HOUR_MS;
    const record: SubscriptionRecord = {
      id: "sub_month_end",
      mollie: {
        resource: "subscription",
        id: "sub_month_end",
        status: "active",
        amount: { currency: "EUR", value: "10.00" },
        interval: "1 month",
        startDate: "2026-11-30",
        description: "Subscription (month-end)",
        customerId: "cst_month_end",
        createdAt: new Date(created).toISOString(),
      },
      own: {
        reference: "month-end",
        interval: "month",
        intervalCount: 1,
        start: "charged",
      },
    };
    const subscription = ToSubscription(record, created + HOUR_MS);
    assert.equal(
      subscription.currentPeriodStart,
      StartOf(ParseDate("2026-10-31")),
    );
    assert.equal(
      subscription.currentPeriodEnd,
      StartOf(ParseDate("2026-11-30")),
    );
  });
});
