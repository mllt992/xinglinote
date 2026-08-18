export const ErrorCodes = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  EXISTS_INVISIBLE: "EXISTS_INVISIBLE",
  CONFLICT_VERSION: "CONFLICT_VERSION",
  GONE_TRASHED: "GONE_TRASHED",
  EXPIRED: "EXPIRED",
  QUOTA: "QUOTA",
  VALIDATION: "VALIDATION",
  RATE_LIMIT: "RATE_LIMIT",
  AI_NOT_CONFIGURED: "AI_NOT_CONFIGURED",
  AI_PROVIDER_ERROR: "AI_PROVIDER_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const httpStatus: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  EXISTS_INVISIBLE: 403,
  CONFLICT_VERSION: 409,
  GONE_TRASHED: 410,
  EXPIRED: 410,
  QUOTA: 413,
  VALIDATION: 422,
  RATE_LIMIT: 429,
  AI_NOT_CONFIGURED: 422,
  AI_PROVIDER_ERROR: 502,
};

export function fail(code: ErrorCode, message: string, fields?: Record<string, string>) {
  return new AppError(code, message, httpStatus[code], fields);
}
