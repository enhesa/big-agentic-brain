/**
 * Domain errors that API routes translate directly into `{ error }` JSON
 * with the matching status code. Anything else thrown by a lib function
 * (e.g. a plain Error from lib/redact.ts's assertSize) is treated by the
 * caller as a 400 validation failure — see app/api/**\/route.ts.
 */
import type { SimilarLearning } from "./learnings";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "Not found") {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "Forbidden") {
    super(message, 403);
    this.name = "ForbiddenError";
  }
}

export class ValidationError extends ApiError {
  constructor(message = "Invalid request") {
    super(message, 400);
    this.name = "ValidationError";
  }
}

/** A per-identity budget (e.g. the auto-reply hourly budget) was exceeded. */
export class TooManyRequestsError extends ApiError {
  constructor(message = "Too many requests") {
    super(message, 429);
    this.name = "TooManyRequestsError";
  }
}

/**
 * Write-time duplicate guard (docs/spec.md "Garbage collection": "Dedup at
 * write time"). Carries the candidate learnings that triggered the 409 so
 * the API response can show them without a second lookup.
 */
export class ConflictError extends ApiError {
  candidates: SimilarLearning[];
  constructor(message = "Conflict", candidates: SimilarLearning[] = []) {
    super(message, 409);
    this.name = "ConflictError";
    this.candidates = candidates;
  }
}

/** Maps any thrown value to a { status, body } pair for an API response. */
export function toApiError(
  err: unknown,
): { status: number; body: { error: string; candidates?: SimilarLearning[] } } {
  if (err instanceof ConflictError) {
    return { status: err.status, body: { error: err.message, candidates: err.candidates } };
  }
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: err.message } };
  }
  if (err instanceof Error) {
    return { status: 400, body: { error: err.message } };
  }
  return { status: 400, body: { error: "Something went wrong" } };
}
