import {
  type Guard,
  IsCount,
  IsFlag,
  IsText,
  ListOf,
  Nullable,
  ObjectWith,
  OneOf,
  Optional,
  RecordOf,
} from "./guards";
import { IsJsonValue } from "./json";
import type {
  MollieAmount,
  MollieCustomer,
  MollieMandate,
  MolliePayment,
  MollieRefund,
  MollieSubscription,
} from "./types";

type MollieLink = NonNullable<MolliePayment["_links"][string]>;

const IsMollieAmount = ObjectWith<MollieAmount>({
  currency: IsText,
  value: IsText,
});

const IsMollieLink = ObjectWith<MollieLink>({
  href: IsText,
  type: Optional(IsText),
});

const IsMetadata = Optional(IsJsonValue);
const IsTimestamp = Nullable(IsText);

export const IsMolliePayment: Guard<MolliePayment> = ObjectWith<MolliePayment>({
  resource: OneOf(["payment"]),
  id: IsText,
  mode: OneOf(["live", "test"]),
  description: IsText,
  amount: IsMollieAmount,
  amountRefunded: Optional(IsMollieAmount),
  amountRemaining: Optional(IsMollieAmount),
  amountCaptured: Optional(IsMollieAmount),
  status: OneOf([
    "open",
    "pending",
    "authorized",
    "paid",
    "canceled",
    "expired",
    "failed",
  ]),
  sequenceType: OneOf(["oneoff", "first", "recurring"]),
  captureMode: Nullable(OneOf(["automatic", "manual"])),
  method: Nullable(IsText),
  metadata: IsMetadata,
  customerId: Nullable(IsText),
  mandateId: Nullable(IsText),
  subscriptionId: Nullable(IsText),
  details: Nullable(
    ObjectWith<NonNullable<MolliePayment["details"]>>({
      failureReason: Nullable(IsText),
      failureMessage: Nullable(IsText),
      bankReasonCode: Nullable(IsText),
      bankReason: Nullable(IsText),
    }),
  ),
  redirectUrl: Nullable(IsText),
  webhookUrl: Nullable(IsText),
  createdAt: IsText,
  authorizedAt: IsTimestamp,
  paidAt: IsTimestamp,
  canceledAt: IsTimestamp,
  expiresAt: IsTimestamp,
  expiredAt: IsTimestamp,
  failedAt: IsTimestamp,
  isCancelable: Nullable(IsFlag),
  _links: RecordOf(Nullable(IsMollieLink)),
});

export const IsMollieRefund: Guard<MollieRefund> = ObjectWith<MollieRefund>({
  resource: OneOf(["refund"]),
  id: IsText,
  amount: IsMollieAmount,
  status: OneOf([
    "queued",
    "pending",
    "processing",
    "refunded",
    "failed",
    "canceled",
  ]),
  paymentId: IsText,
  description: Optional(IsText),
  metadata: IsMetadata,
  createdAt: IsText,
});

export const IsMollieCustomer: Guard<MollieCustomer> =
  ObjectWith<MollieCustomer>({
    resource: OneOf(["customer"]),
    id: IsText,
    name: Nullable(IsText),
    email: Nullable(IsText),
    metadata: IsMetadata,
    createdAt: IsText,
  });

export const IsMollieMandate: Guard<MollieMandate> = ObjectWith<MollieMandate>({
  resource: OneOf(["mandate"]),
  id: IsText,
  method: OneOf(["creditcard", "directdebit", "paypal"]),
  status: OneOf(["valid", "pending", "invalid"]),
  scopes: Nullable(ListOf(IsText)),
  details: Nullable(
    ObjectWith<NonNullable<MollieMandate["details"]>>({
      cardNumber: Nullable(IsText),
      cardLabel: Nullable(IsText),
      cardExpiryDate: Nullable(IsText),
      consumerAccount: Nullable(IsText),
    }),
  ),
  customerId: Optional(IsText),
  createdAt: IsText,
});

export const IsMollieSubscription: Guard<MollieSubscription> =
  ObjectWith<MollieSubscription>({
    resource: OneOf(["subscription"]),
    id: IsText,
    status: OneOf(["pending", "active", "canceled", "suspended", "completed"]),
    amount: IsMollieAmount,
    times: Nullable(IsCount),
    timesRemaining: Nullable(IsCount),
    interval: IsText,
    startDate: IsText,
    nextPaymentDate: Nullable(IsText),
    description: IsText,
    metadata: IsMetadata,
    webhookUrl: Nullable(IsText),
    customerId: IsText,
    mandateId: Nullable(IsText),
    createdAt: IsText,
    canceledAt: IsTimestamp,
  });

/** A page of payments embedded in another resource's listing. */
export const IsMolliePaymentPage = ObjectWith<{
  _embedded?: { payments?: MolliePayment[] };
}>({
  _embedded: Optional(
    ObjectWith<{ payments?: MolliePayment[] }>({
      payments: Optional(ListOf(IsMolliePayment)),
    }),
  ),
});
