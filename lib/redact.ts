/**
 * Write-side redaction. Every free-text field an agent can store (learning
 * title/body/tags/repo, todo title/body/related key, message subject/body,
 * kudos notes, display names) passes through `redact()` before it hits SQLite,
 * so secrets and personal data never persist and never reach another agent's
 * chat. The maintenance sweep (lib/maintenance.ts) re-applies it to existing
 * rows, so widening a pattern here also cleans history.
 *
 * Secrets become `[redacted]`; personal data becomes `[redacted <kind>]`. The
 * patterns are deliberately conservative where prose collides (git SHAs, ISO
 * dates, Jira keys and version numbers must survive), see tests/redact*.test.ts.
 */
import { config } from "./config";

const REDACTED = "[redacted]";
const EMAIL = "[redacted email]";
const PHONE = "[redacted phone]";
const CARD = "[redacted card]";
const IBAN = "[redacted iban]";
const ID = "[redacted id]";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Colleagues' addresses are fine: the whole memory is per-person by email. Built at use time from config. */
function internalEmailDomains(): RegExp[] {
  return config().redact.domains.map((d) => new RegExp("(^|\\.)" + escapeRegExp(d) + "$", "i"));
}

// Order matters: more specific patterns first so we don't partially mask a match
// that a later, broader pattern would have caught more cleanly.
const SECRET_PATTERNS: RegExp[] = [
  // PEM private keys (RSA, EC, OPENSSH, PGP, generic), whole block.
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
  // JWTs: three base64url segments, first one is a JSON header ("eyJ").
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Credentials embedded in URLs: scheme://user:pass@host -> scheme://[redacted]@host
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s@/]+@/gi,
  // Bearer / Basic authorization values. Only a credential-shaped value counts (12+ characters
  // with a digit, a symbol or an inner capital), so prose like "the bearer challenge" or
  // "plain Basic auth" stays readable (feedback f8942f33, 2026-10-07).
  /\b(?:[Bb]earer|BEARER|[Bb]asic|BASIC)\s+(?=[A-Za-z0-9\-._~+/]{12,})(?=[A-Za-z0-9\-._~+/]*(?:[0-9+/_.~-]|[a-z][A-Z]))[A-Za-z0-9\-._~+/]+=*/g,
  // Header-style credentials: Authorization: xxx, X-Api-Key: xxx, api-key=xxx
  /\b(?:authorization|x-api-key|x-auth-token|api-key|x-functions-key|ocp-apim-subscription-key)\s*[:=]\s*[^\s;,]+/gi,
  // AWS access key ids and secret access keys next to their label.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\baws_secret_access_key\s*[:=]\s*[^\s;,]+/gi,
  // Azure: storage account keys, SAS signatures, shared access signatures.
  /\b(?:AccountKey|SharedAccessKey)\s*=\s*[A-Za-z0-9+/=]{20,}/gi,
  /\bSharedAccessSignature\s*=\s*[^\s;,]+/gi,
  /\bsig=[A-Za-z0-9%+/=]{20,}/gi,
  // Vendor tokens by prefix.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // BAB personal tokens (issued until 2026-10-01, now gone): bab_ + 43 base64url characters.
  // Kept so an old one pasted into content is still masked. The lookahead needs an uppercase
  // letter or digit, which random output has, so a 43-character snake_case identifier that
  // starts with bab_ is left alone.
  /(?<![A-Za-z0-9_])bab_(?=[A-Za-z0-9_-]{0,42}[A-Z0-9])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bATATT3[A-Za-z0-9_\-=]{20,}\b/g, // Atlassian
  /\bxox[baprse]-[A-Za-z0-9-]{10,}\b/gi, // Slack
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, // OpenAI
  /\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/g, // Stripe
  /\brk_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm
  /\bhf_[A-Za-z0-9]{30,}\b/g, // Hugging Face
  /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, // SendGrid
  /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}\b/g, // PyPI
  /\bdop_v1_[a-f0-9]{60,}\b/g, // DigitalOcean
  /\bhvs\.[A-Za-z0-9_-]{20,}\b/g, // HashiCorp Vault
  // Legacy Vault tokens: `s.` plus 24 base62. The digit lookahead keeps code like
  // `s.SomeLongMethodNameHere` (a variable called s) out; random tokens almost always have one.
  /(?<![A-Za-z0-9_])s\.(?=[A-Za-z0-9]{0,23}\d)[A-Za-z0-9]{24}(?![A-Za-z0-9])/g,
  // Azure DevOps PATs are 52 chars of base32. Only the labelled shapes (`pat <x>`, `pat=<x>`,
  // `:<x>` as in a basic-auth string): a bare 52-char run is too common in prose and ids.
  /(?<![A-Za-z0-9_])pat[\s=:]+(?=[a-z2-7]{0,51}\d)(?=[a-z2-7]{0,51}[a-z])[a-z2-7]{52}(?![A-Za-z0-9])/gi,
  /(?<=:)(?=[a-z2-7]{0,51}\d)(?=[a-z2-7]{0,51}[a-z])[a-z2-7]{52}(?![A-Za-z0-9])/g,
  /\bsplunk[_-]?token\s*[:=]\s*[^\s;,]+/gi,
  // key=value style secrets: password=..., token=..., secret=..., apikey=...
  // The key may carry a prefix (ENH_NUGET_PASSWORD, clientSecret) and be quoted as JSON
  // does ("password": "x"). A lookbehind, not a word boundary: an underscore is a word character, so
  // a boundary would never match inside ENH_NUGET_PASSWORD. Needs a value after : or =, so the
  // bare word "password" in prose is left alone. The lookbehind also excludes "_", or a
  // match could start after every underscore in a long run and the scan goes quadratic.
  // Flags, nulls and plain numbers (requirePassword: true, max_token: 4000) are not secrets.
  /(?<![A-Za-z0-9_])["']?[A-Za-z0-9_]*(?:password|passwd|pwd|token|secret|apikey|api_key|access_token|refresh_token|client_secret|clientsecret|private_key|sas_token|auth_token|bearer_token|session_key|signing_key|encryption_key|connection_string|connectionstring)["']?\s*[:=]\s*["']?(?!(?:true|false|null|undefined|\d+)["']?(?![A-Za-z0-9_-]))[^\s;,"']+["']?/gi,
  // connection strings with ;Password=... / ;Pwd=...
  /;\s*(?:Password|Pwd)\s*=\s*[^;]+/gi,
  // long base64/hex blobs (>=32 chars) sitting next to key/token/secret words
  /\b(?:key|token|secret)\b\s*[:=]?\s*[A-Za-z0-9+/_-]{32,}={0,2}/gi,
];

// --- Personal data -----------------------------------------------------------

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

function redactEmails(text: string): string {
  const internal = internalEmailDomains();
  return text.replace(EMAIL_RE, (whole, domain: string) =>
    internal.some((d) => d.test(domain)) ? whole : EMAIL,
  );
}

/** Candidate runs of digits with phone-style separators; validated in code, not regex. */
const PHONE_CANDIDATE_RE = /(?<![\w.\-/])(?:\+|00)?\(?\d[\d\s().\/-]{7,20}\d(?![\w.\-/])/g;
const ISO_DATE_LIKE_RE = /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/;
const PLAIN_NUMBER_RE = /^\d+$/;

function looksLikePhone(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (ISO_DATE_LIKE_RE.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return false;
  // A bare run of digits with no separators is an id, an amount or a timestamp
  // more often than a phone number; require an international prefix for those.
  const international = /^(\+|00)/.test(trimmed);
  if (PLAIN_NUMBER_RE.test(trimmed) && !international) return false;
  // National formats start with 0 (or a bracketed area code); anything else that
  // isn't international is most likely not a phone number.
  const national = /^\(?0/.test(trimmed);
  // North American numbers have no leading 0: accept the grouped 3-3-4 form with
  // separators, e.g. "(212) 555-1234" or "212-555-1234" (review, 2026-09-25).
  const northAmerican = /^(\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}$/.test(trimmed);
  return international || national || northAmerican;
}

function redactPhones(text: string): string {
  return text.replace(PHONE_CANDIDATE_RE, (m) => (looksLikePhone(m) ? PHONE : m));
}

/** 13-19 digits, optional single spaces/dashes, must pass Luhn. */
const CARD_CANDIDATE_RE = /(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactCards(text: string): string {
  return text.replace(CARD_CANDIDATE_RE, (m) => {
    const digits = m.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return m;
    // All-same-digit or obviously sequential runs are test data / ids, not cards.
    if (/^(\d)\1+$/.test(digits)) return m;
    // An unseparated run is usually an id or epoch timestamp; only the two
    // common card lengths are considered without separators.
    if (!/[ -]/.test(m) && digits.length !== 15 && digits.length !== 16) return m;
    return luhnValid(digits) ? CARD : m;
  });
}

/** IBAN: country code, 2 check digits, 11-30 alphanumerics, mod-97 == 1. Spaces allowed in groups of 4. */
const IBAN_CANDIDATE_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/\s+/g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

function redactIbans(text: string): string {
  return text.replace(IBAN_CANDIDATE_RE, (m) => (ibanValid(m) ? IBAN : m));
}

/** National identifiers with an unambiguous written form. */
const NATIONAL_ID_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/g, // US SSN
  /\b\d{2}\.\d{2}\.\d{2}-\d{3}\.\d{2}\b/g, // Belgian national register number
  /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g, // UK National Insurance number
  /\b\d{9}\b(?=\s*\(?(?:BSN|burgerservicenummer)\)?)/gi, // Dutch BSN when labelled
];

function redactNationalIds(text: string): string {
  let result = text;
  for (const pattern of NATIONAL_ID_PATTERNS) result = result.replace(pattern, ID);
  return result;
}

// --- Public API --------------------------------------------------------------

/**
 * `emails: false` skips email masking for this call. The stored-row sweep uses it when no
 * internal domain list is configured, so it cannot mask every stored colleague address.
 */
export function redact(text: string, opts: { emails?: boolean } = {}): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (whole, ...groups: unknown[]) => {
      // URL-credential pattern keeps its scheme (first capture group).
      const scheme = typeof groups[0] === "string" && /:\/\/$/.test(groups[0]) ? groups[0] : "";
      return scheme ? `${scheme}${REDACTED}@` : REDACTED;
    });
  }
  if (config().redact.pii && opts.emails !== false) result = redactEmails(result);
  result = redactIbans(result);
  result = redactCards(result);
  result = redactNationalIds(result);
  result = redactPhones(result);
  return result;
}

/** True when `redact(text)` would change it: callers can warn the agent that something was masked. */
export function containsSensitive(text: string): boolean {
  return redact(text) !== text;
}

/**
 * Cap on what redact() is ever asked to scan: a multiple of the field limit, because
 * redaction can legitimately shrink text (a PEM block becomes "[redacted]") but must not
 * be handed megabytes. Call BEFORE redact().
 */
const RAW_FACTOR = 4;
export function assertRawLength(field: string, text: string, max: number): void {
  if (text.length > max * RAW_FACTOR) {
    throw new Error(`${field} must be ${max} characters or fewer`);
  }
}

export function assertSize(text: string, max: number): void {
  const size = Buffer.byteLength(text, "utf8");
  if (size > max) {
    throw new Error(`Content too large: ${size} bytes exceeds max of ${max} bytes`);
  }
}

/** Validation errors in human units (characters), not bytes: "title must be 160 characters or fewer". */
export function assertMaxLength(field: string, text: string, max: number): void {
  if (text.length > max) {
    throw new Error(`${field} must be ${max} characters or fewer`);
  }
}
