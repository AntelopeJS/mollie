export interface MollieErrorBody {
  status?: number;
  title?: string;
  detail?: string;
  field?: string;
}

const UNREACHABLE = 0;
const NOT_FOUND = 404;

export class MollieApiError extends Error {
  readonly status: number;
  readonly title?: string;
  readonly field?: string;

  constructor(status: number, body: MollieErrorBody) {
    super(body.detail ?? body.title ?? `Mollie answered ${status}`);
    this.name = "MollieApiError";
    this.status = status;
    this.title = body.title;
    this.field = body.field;
  }

  static unreachable(cause: unknown): MollieApiError {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new MollieApiError(UNREACHABLE, {
      detail: `Mollie could not be reached: ${reason}`,
    });
  }

  get isNotFound(): boolean {
    return this.status === NOT_FOUND;
  }

  get providerCode(): string {
    return this.field ? `${this.status}:${this.field}` : String(this.status);
  }
}

export function IsNotFound(error: unknown): boolean {
  return error instanceof MollieApiError && error.isNotFound;
}
