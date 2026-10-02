import {
  CustomerNotFoundError,
  type CustomerEntity,
  type PaymentEntity,
  PaymentError,
  PaymentNotFoundError,
} from "@antelopejs/interface-payment";

import { MollieApiError } from "../../mollie/errors";

export type Entity = CustomerEntity | PaymentEntity;

const CUSTOMER_ENTITIES = new Set<Entity>(["customer", "payment method"]);

export function NotFound(id: string, entity: Entity, code?: string): Error {
  if (CUSTOMER_ENTITIES.has(entity)) {
    return new CustomerNotFoundError(id, entity as CustomerEntity, code);
  }
  return new PaymentNotFoundError(id, entity as PaymentEntity, code);
}

function TranslateError(error: unknown, id: string, entity: Entity): unknown {
  if (!(error instanceof MollieApiError)) {
    return error;
  }
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
    throw TranslateError(error, id, entity);
  }
}
