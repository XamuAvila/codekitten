/**
 * AppErrorCode — the only structured error codes used across the system.
 */
export type AppErrorCode = "VALIDATION" | "NOT_FOUND" | "DUPLICATE" | "SERVICE_UNAVAILABLE" | "AUTH_FAILED";

export interface AppErrorDetail {
  readonly [key: string]: unknown;
}

/**
 * Structured error — every failure in the system uses this shape,
 * never bare strings: { code, message, details? }.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: readonly AppErrorDetail[];

  constructor(code: AppErrorCode, message: string, details?: readonly AppErrorDetail[]) {
    super(message);
    this.name = "AppError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
