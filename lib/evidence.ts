import { redact } from "./redact";
import { ValidationError } from "./errors";

/**
 * Structured evidence on a flag or a correction (docs/spec.md "Self-healing memory"). Optional, next
 * to the free-text note. Checked with plain rules, no model on the server: a known failure kind and
 * short text fields, each trimmed and redacted like a note. Stored as JSON in trust_events.evidence
 * and shown in the validation history. `where` lets a person see that a flag came from a broken
 * branch, not from main.
 */
export const EVIDENCE_FAILURES = [
  "command_failed",
  "path_missing",
  "api_error",
  "wrong_output",
  "contradicts_code",
  "contradicts_memory",
] as const;
export type EvidenceFailure = (typeof EVIDENCE_FAILURES)[number];

/** Each text field of the evidence holds at most this many characters, after redaction. */
export const EVIDENCE_FIELD_MAX = 300;

export interface FlagEvidence {
  failure?: EvidenceFailure;
  /** The exact command, file or address checked. */
  tried?: string;
  /** The short result: exit code, error line, actual value. */
  saw?: string;
  /** Repo and branch or commit, when there is one. */
  where?: string;
}

const TEXT_FIELDS = ["tried", "saw", "where"] as const;

/**
 * The evidence from a request body or tool arguments, or null when none was given. Unknown keys,
 * an unknown failure kind or a field that is not text are refused, so a typo is never silently
 * dropped. An object with no field set is null.
 */
export function parseEvidence(raw: unknown): FlagEvidence | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("evidence must be an object with failure, tried, saw and where");
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== "failure" && !(TEXT_FIELDS as readonly string[]).includes(key)) {
      throw new ValidationError(`evidence has an unknown field: ${key.slice(0, 40)}. Use failure, tried, saw and where`);
    }
  }
  const out: FlagEvidence = {};
  if (obj.failure != null) {
    if (typeof obj.failure !== "string" || !(EVIDENCE_FAILURES as readonly string[]).includes(obj.failure)) {
      throw new ValidationError(`evidence.failure must be one of ${EVIDENCE_FAILURES.join(", ")}`);
    }
    out.failure = obj.failure as EvidenceFailure;
  }
  for (const key of TEXT_FIELDS) {
    const v = obj[key];
    if (v == null) continue;
    if (typeof v !== "string") throw new ValidationError(`evidence.${key} must be text`);
    const trimmed = v.trim();
    if (!trimmed) continue;
    if (trimmed.length > EVIDENCE_FIELD_MAX) {
      throw new ValidationError(`evidence.${key} must be ${EVIDENCE_FIELD_MAX} characters or fewer`);
    }
    const redacted = redact(trimmed);
    if (redacted.length > EVIDENCE_FIELD_MAX) {
      throw new ValidationError(`evidence.${key} must be ${EVIDENCE_FIELD_MAX} characters or fewer after redaction (emails and numbers are replaced)`);
    }
    out[key] = redacted;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Stored evidence back as an object, or undefined for none or a row that no longer parses. */
export function readEvidence(raw: string | null | undefined): FlagEvidence | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as FlagEvidence) : undefined;
  } catch {
    return undefined;
  }
}
