export interface MollieAmount {
  currency: string;
  value: string;
}

interface MollieLink {
  href: string;
  type?: string;
}

type MollieLinks = Record<string, MollieLink | null | undefined>;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type MollieMetadata = JsonValue;

export type MolliePaymentStatus =
  | "open"
  | "pending"
  | "authorized"
  | "paid"
  | "canceled"
  | "expired"
  | "failed";

export type MollieSequenceType = "oneoff" | "first" | "recurring";

interface MolliePaymentDetails {
  failureReason?: string | null;
  failureMessage?: string | null;
  bankReasonCode?: string | null;
  bankReason?: string | null;
}

export interface MolliePayment {
  resource: "payment";
  id: string;
  mode: "live" | "test";
  description: string;
  amount: MollieAmount;
  amountRefunded?: MollieAmount;
  amountRemaining?: MollieAmount;
  amountCaptured?: MollieAmount;
  status: MolliePaymentStatus;
  sequenceType: MollieSequenceType;
  captureMode?: "automatic" | "manual" | null;
  method?: string | null;
  metadata?: MollieMetadata;
  customerId?: string | null;
  mandateId?: string | null;
  subscriptionId?: string | null;
  details?: MolliePaymentDetails | null;
  redirectUrl?: string | null;
  webhookUrl?: string | null;
  createdAt: string;
  authorizedAt?: string | null;
  paidAt?: string | null;
  canceledAt?: string | null;
  expiresAt?: string | null;
  expiredAt?: string | null;
  failedAt?: string | null;
  isCancelable?: boolean | null;
  _links: MollieLinks;
}

export type MollieRefundStatus =
  | "queued"
  | "pending"
  | "processing"
  | "refunded"
  | "failed"
  | "canceled";

export interface MollieRefund {
  resource: "refund";
  id: string;
  amount: MollieAmount;
  status: MollieRefundStatus;
  paymentId: string;
  description?: string;
  metadata?: MollieMetadata;
  createdAt: string;
}

type MollieCaptureStatus = "pending" | "succeeded" | "failed";

export interface MollieCapture {
  resource: "capture";
  id: string;
  mode: "live" | "test";
  amount?: MollieAmount | null;
  status: MollieCaptureStatus;
  paymentId: string;
  metadata?: MollieMetadata;
  createdAt: string;
}

export interface MollieCustomer {
  resource: "customer";
  id: string;
  name?: string | null;
  email?: string | null;
  metadata?: MollieMetadata;
  createdAt: string;
}

type MollieMandateMethod = "creditcard" | "directdebit" | "paypal";

interface MollieMandateDetails {
  cardNumber?: string | null;
  cardLabel?: string | null;
  cardExpiryDate?: string | null;
  consumerAccount?: string | null;
}

export interface MollieMandate {
  resource: "mandate";
  id: string;
  method: MollieMandateMethod;
  status: "valid" | "pending" | "invalid";
  scopes?: string[] | null;
  details?: MollieMandateDetails | null;
  customerId?: string;
  createdAt: string;
}

type MollieSubscriptionStatus =
  | "pending"
  | "active"
  | "canceled"
  | "suspended"
  | "completed";

export interface MollieSubscription {
  resource: "subscription";
  id: string;
  status: MollieSubscriptionStatus;
  amount: MollieAmount;
  times?: number | null;
  timesRemaining?: number | null;
  interval: string;
  startDate: string;
  nextPaymentDate?: string | null;
  description: string;
  metadata?: MollieMetadata;
  webhookUrl?: string | null;
  customerId: string;
  mandateId?: string | null;
  createdAt: string;
  canceledAt?: string | null;
}
