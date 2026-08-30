/**
 * A single, Stripe-shaped error envelope used by the API, the SDK and the UI.
 *   { error: { type, code, message, param?, doc_url?, request_id? } }
 */
export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'conflict_error'
  | 'rate_limit_error'
  | 'idempotency_error'
  | 'card_error'
  | 'api_error';

export interface ApiErrorBody {
  type: ErrorType;
  code: string;
  message: string;
  param?: string;
  detail?: unknown;
  doc_url?: string;
  request_id?: string;
}

const STATUS: Record<ErrorType, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  conflict_error: 409,
  idempotency_error: 409,
  rate_limit_error: 429,
  card_error: 402,
  api_error: 500,
};

export class ApiError extends Error {
  readonly type: ErrorType;
  readonly code: string;
  readonly param?: string;
  readonly detail?: unknown;
  readonly status: number;
  readonly docUrl?: string;

  constructor(type: ErrorType, code: string, message: string, opts: { param?: string; detail?: unknown; docUrl?: string } = {}) {
    super(message);
    this.name = 'ApiError';
    this.type = type;
    this.code = code;
    this.param = opts.param;
    this.detail = opts.detail;
    this.docUrl = opts.docUrl ?? `https://docs.ain.dev/errors/${code}`;
    this.status = STATUS[type];
  }

  toBody(requestId?: string): { error: ApiErrorBody } {
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
        ...(this.param ? { param: this.param } : {}),
        ...(this.detail !== undefined ? { detail: this.detail } : {}),
        doc_url: this.docUrl,
        ...(requestId ? { request_id: requestId } : {}),
      },
    };
  }
}

export const badRequest = (code: string, message: string, param?: string, detail?: unknown) =>
  new ApiError('invalid_request_error', code, message, { param, detail });
export const unauthorized = (message = 'No valid API key or session provided.') =>
  new ApiError('authentication_error', 'unauthorized', message);
export const forbidden = (message: string, detail?: unknown) =>
  new ApiError('permission_error', 'forbidden', message, { detail });
export const notFound = (resource: string, id?: string) =>
  new ApiError('not_found_error', 'resource_missing', id ? `No such ${resource}: ${id}` : `No such ${resource}.`, { param: 'id' });
export const conflict = (code: string, message: string, detail?: unknown) =>
  new ApiError('conflict_error', code, message, { detail });
export const rateLimited = (message = 'Too many requests. Please retry with exponential backoff.') =>
  new ApiError('rate_limit_error', 'rate_limit', message);
export const internal = (message = 'An unexpected error occurred.', detail?: unknown) =>
  new ApiError('api_error', 'internal_error', message, { detail });

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError || (typeof e === 'object' && e !== null && (e as any).name === 'ApiError');
}
