import type { StandInBody, StandInResponse } from "./state";
import { DefinedFields, Lookup } from "../../mollie/fields";

const DOCUMENTATION = {
  documentation: {
    href: "https://docs.mollie.com/reference/handling-errors",
    type: "text/html",
  },
};

const TITLES = {
  400: "Bad Request",
  401: "Unauthorized Request",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Entity",
  503: "Service Unavailable",
} satisfies Record<number, string>;

export class StandInError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly field?: string,
  ) {
    super(detail);
  }

  toResponse(): StandInResponse {
    return {
      status: this.status,
      body: {
        status: this.status,
        title: Lookup(TITLES, this.status) ?? "Error",
        detail: this.detail,
        ...DefinedFields({ field: this.field }),
        _links: DOCUMENTATION,
      },
    };
  }
}

export function NotFound(resource: string, id: string): StandInError {
  return new StandInError(404, `No ${resource} exists with token ${id}.`);
}

export function Unprocessable(detail: string, field?: string): StandInError {
  return new StandInError(422, detail, field);
}

export function Ok(body: StandInBody, status = 200): StandInResponse {
  return { status, body };
}

export const NO_CONTENT: StandInResponse = { status: 204 };
