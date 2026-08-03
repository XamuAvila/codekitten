import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";
import { AppError } from "@kitten/shared";

/**
 * Returns Express middleware that validates `req.body` against the given Zod
 * schema. Invalid payloads trigger a VALIDATION AppError that the global
 * error handler converts into a structured 400 response.
 */
export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);

    if (result.success) {
      req.body = result.data;
      next();
      return;
    }

    const details = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));

    next(new AppError("VALIDATION", "Invalid payload", details));
  };
}
