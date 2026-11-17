import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodTypeAny, type z } from "zod";

import type { ProblemDetails } from "@bankbuddy/contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  static notFound(what = "Resource"): ApiError {
    return new ApiError(404, "not_found", `${what} not found`);
  }

  static forbidden(code = "forbidden", message = "You do not have permission to do that"): ApiError {
    return new ApiError(403, code, message);
  }

  static unauthenticated(): ApiError {
    return new ApiError(401, "unauthenticated", "Sign in to continue");
  }

  static conflict(message: string, current: unknown): ApiError {
    return new ApiError(409, "version_conflict", message, { current });
  }

  static validation(message: string, errors: Array<{ path: string; message: string }>): ApiError {
    return new ApiError(422, "validation_failed", message, { errors });
  }
}

export function parseBody<T extends ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  try {
    return schema.parse(body ?? {});
  } catch (error) {
    if (error instanceof ZodError) {
      throw ApiError.validation(
        "Request body is not valid",
        error.issues.map((issue) => ({ path: issue.path.join(".") || "(body)", message: issue.message })),
      );
    }
    throw error;
  }
}

export function problemFrom(error: unknown): { status: number; body: ProblemDetails } {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: {
        type: `https://bankbuddy.example/problems/${error.code}`,
        title: error.message,
        status: error.status,
        code: error.code,
        ...(error.extra as Partial<ProblemDetails>),
      },
    };
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  return {
    status: 500,
    body: {
      type: "https://bankbuddy.example/problems/internal",
      title: "Something went wrong",
      status: 500,
      code: "internal_error",
      ...(process.env.NODE_ENV === "production" ? {} : { detail: message }),
    },
  };
}

export function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const { status, body } = problemFrom(error);
  if (status >= 500) console.error("[api] unhandled error", error);
  res.status(status).type("application/problem+json").json(body);
}

/** Wraps an async route so Express 5 forwards rejections to the error handler. */
export function route<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(fn: T) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await fn(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

export function ifMatchVersion(req: Request): number | null {
  const header = req.header("if-match");
  if (!header) return null;
  const match = /^"?(\d+)"?$/.exec(header.trim());
  return match ? Number(match[1]) : null;
}
