import {
  CustomerNotFoundError,
  type CustomerEntity,
  type PaymentEntity,
  PaymentError,
  PaymentNotFoundError,
} from "@antelopejs/interface-payment";

import { MollieApiError } from "../../mollie/errors";

export type Entity = CustomerEntity | PaymentEntity;

const CUSTOMER_ENTITIES: ReadonlySet<Entity> = new Set<CustomerEntity>([
  "customer",
  "payment method",
]);

function isCustomerEntity(entity: Entity): entity is CustomerEntity {
  return CUSTOMER_ENTITIES.has(entity);
}

export function NotFound(id: string, entity: Entity, code?: string): Error {
  if (isCustomerEntity(entity)) {
    return new CustomerNotFoundError(id, entity, code);
  }
  return new PaymentNotFoundError(id, entity, code);
}

function TranslateError(
  error: MollieApiError,
  id: string,
  entity: Entity,
): Error {
  if (error.isNotFound) {
    return NotFound(id, entity, error.providerCode);
  }
  return new PaymentError(error.message, error.providerCode);
}

export async function Translating<T>(
  id: string,
  entity: Entity,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof MollieApiError)) throw error;
    throw TranslateError(error, id, entity);
  }
}

/**
 * Awaits two reads that run together. When both fail, or the second fails
 * sooner, it rejects with the first read's error: the error the caller would
 * have seen had the reads run in turn.
 */
export async function InTurnOrder<First, Second>(
  first: Promise<First>,
  second: Promise<Second>,
): Promise<[First, Second]> {
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);
  if (firstResult.status === "rejected") throw firstResult.reason;
  if (secondResult.status === "rejected") throw secondResult.reason;
  return [firstResult.value, secondResult.value];
}
