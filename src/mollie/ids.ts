const SEPARATOR = ":";

const PATTERNS = {
  customer: /^cst_[A-Za-z0-9]+$/,
  mandate: /^mdt_[A-Za-z0-9]+$/,
  payment: /^tr_[A-Za-z0-9]+$/,
  refund: /^re_[A-Za-z0-9]+$/,
  subscription: /^sub_[A-Za-z0-9]+$/,
};

export type MollieIdKind = keyof typeof PATTERNS;

export interface CompositeId {
  parent: string;
  child: string;
}

export function IsMollieId(kind: MollieIdKind, id: string): boolean {
  return PATTERNS[kind].test(id);
}

function compose(parent: string, child: string): string {
  return `${parent}${SEPARATOR}${child}`;
}

function decompose(
  id: string,
  parentKind: MollieIdKind,
  childKind: MollieIdKind,
): CompositeId | undefined {
  const parts = id.split(SEPARATOR);
  if (parts.length !== 2) {
    return undefined;
  }
  const [parent, child] = parts;
  const isValid =
    IsMollieId(parentKind, parent) && IsMollieId(childKind, child);
  return isValid ? { parent, child } : undefined;
}

export function PaymentMethodId(customerId: string, mandateId: string): string {
  return compose(customerId, mandateId);
}

export function ParsePaymentMethodId(id: string): CompositeId | undefined {
  return decompose(id, "customer", "mandate");
}

export function RefundId(paymentId: string, refundId: string): string {
  return compose(paymentId, refundId);
}

export function ParseRefundId(id: string): CompositeId | undefined {
  return decompose(id, "payment", "refund");
}

export function SubscriptionId(
  customerId: string,
  subscriptionId: string,
): string {
  return compose(customerId, subscriptionId);
}

export function ParseSubscriptionId(id: string): CompositeId | undefined {
  return decompose(id, "customer", "subscription");
}
