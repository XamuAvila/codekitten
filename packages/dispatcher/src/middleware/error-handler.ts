import type { Request, Response, NextFunction } from "express";
import { AppError } from "@kitten/shared";

/**
 * Global Express error handler — converts AppError (or unknown errors)
 * into structured JSON responses.
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    res.status(appErrorToHttp(err.code)).json({
      code: err.code,
      message: err.message,
      ...(err.details && { details: err.details }),
    });
    return;
  }

  // Express body-parser errors (invalid JSON, etc.) → 400 VALIDATION
  if (err instanceof SyntaxError && "status" in err && (err as Record<string, unknown>).status === 400) {
    res.status(400).json({
      code: "VALIDATION",
      message: "Invalid payload — body is not valid JSON",
    });
    return;
  }

  // Unknown errors → 500, no leak
  console.error("[dispatcher] Unhandled error:", err);
  res.status(500).json({
    code: "INTERNAL",
    message: "Internal server error",
  });
}

function appErrorToHttp(code: string): number {
  switch (code) {
    case "VALIDATION":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "DUPLICATE":
      return 409;
    default:
      return 500;
  }
}
