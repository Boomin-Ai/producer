// Contract error envelope: every error is { error: { code, message, details? } }.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function errorBody(e: ApiError) {
  return {
    error: {
      code: e.code,
      message: e.message,
      ...(e.details ? { details: e.details } : {}),
    },
  };
}

export function preflight(message: string, issues: { code: string; message: string; field?: string }[]): ApiError {
  return new ApiError(422, "preflight_failed", message, { issues });
}
