/** An error that is safe to show to the client: a status and a stable code. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, details?: Record<string, unknown>) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code = 'bad_request', details?: Record<string, unknown>): HttpError =>
  new HttpError(400, code, details);
export const unauthorized = (code = 'unauthorized'): HttpError => new HttpError(401, code);
export const forbidden = (code = 'forbidden'): HttpError => new HttpError(403, code);
export const stepUpRequired = (): HttpError => new HttpError(403, 'step_up_required');
/**
 * Used both for things that do not exist and for things the person may not
 * see, so that responses never confirm whether a hidden record exists.
 */
export const notFound = (): HttpError => new HttpError(404, 'not_found');
export const conflict = (code = 'conflict', details?: Record<string, unknown>): HttpError =>
  new HttpError(409, code, details);
/** Something the API depends on is out of reach for now. */
export const serviceUnavailable = (code: string): HttpError => new HttpError(503, code);
export const tooManyAttempts = (retryAfterSeconds: number): HttpError =>
  new HttpError(429, 'too_many_attempts', { retryAfterSeconds });
/** Too many requests of any kind in a short time, from one session or address. */
export const tooManyRequests = (retryAfterSeconds: number): HttpError =>
  new HttpError(429, 'too_many_requests', { retryAfterSeconds });

interface PgLikeError {
  code?: unknown;
}

/** Maps database refusals (the second layer of defence) to client errors. */
export function fromDatabaseError(error: unknown): HttpError | undefined {
  const code = (error as PgLikeError | null)?.code;
  if (typeof code !== 'string') return undefined;
  switch (code) {
    case 'CB001': // explicit refusal by a guard
    case '42501': // row-level security or missing privilege
      return forbidden();
    case 'CB002':
      return stepUpRequired();
    case 'CB004': // a stage only some roles put items into
      return forbidden('stage_restricted');
    case 'CB003':
      return conflict('rule_violation');
    case '23505':
      return conflict('already_exists');
    case '23503':
    case '23514':
    case '22P02':
      return badRequest('invalid_reference');
    default:
      return undefined;
  }
}
