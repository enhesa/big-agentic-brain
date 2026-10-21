import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import {
  search,
  recordSearchRead,
  parseSupersedes,
  parseTags,
  parseAliases,
  createWithSupersedes,
  normalizeProjectKey,
  parseFlaggedFilter,
  parseStatusFilter,
  parseKindFilter,
  parseModelFilter,
  readProvenance,
  GENERAL_PROJECT_KEY,
  LEARNINGS_LIST_LIMIT_MAX,
  LEARNINGS_SEARCH_LIMIT_MAX,
} from "@/lib/learnings";
import { parseAppliesToFilter, parseStack, readAppliesTo } from "@/lib/applies-to";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";
import { isCalendarDate } from "@/lib/dates";
import { VERIFY_HINT } from "@/lib/swarm-gc";
import { CONTACTS_HINT, contactsForSearch } from "@/lib/area-contacts";
import type { LearningConfidence } from "@/lib/types";

export const dynamic = "force-dynamic";

const CONFIDENCE_VALUES: LearningConfidence[] = ["low", "medium", "high"];

/** GET /api/learnings?q=&tag=&repo=&project=&author=&status=&kind=&model=&appliesTo=&stack=&flagged=&limit= */
export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "GET", path: "/api/learnings", via: "mcp" });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") ?? "";
  const tag = searchParams.get("tag") ?? undefined;
  const repo = searchParams.get("repo") ?? undefined;
  const author = searchParams.get("author") ?? undefined;
  // Default (no status param): active only. "archived" or "all" opt in explicitly.
  const limitRaw = Number(searchParams.get("limit") ?? "5");
  const max = q.trim() ? LEARNINGS_SEARCH_LIMIT_MAX : LEARNINGS_LIST_LIMIT_MAX;
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 5, 1), max);

  // An unknown kind is a 400, never "unfiltered": a typo must not return ordinary learnings
  // to a caller who asked for standards. Parsed before the project, so a bad kind is an error
  // even when the project below ends the request with an empty page. A repeated ?kind= is
  // joined into one list.
  let kind;
  let flagged;
  let status;
  let model;
  let appliesTo;
  let stack;
  try {
    const kinds = searchParams.getAll("kind");
    kind = parseKindFilter(kinds.length > 0 ? kinds.join(",") : undefined);
    flagged = parseFlaggedFilter(searchParams.get("flagged"));
    status = parseStatusFilter(searchParams.get("status"));
    model = parseModelFilter(searchParams.get("model"));
    // Repeated or comma-separated. appliesTo is strict (a typo is a 400); stack is lenient (see parseStack).
    appliesTo = parseAppliesToFilter(searchParams.getAll("appliesTo").join(",") || undefined);
    stack = parseStack(searchParams.getAll("stack").join(",") || undefined);
  } catch (err) {
    const { status: code, body } = toApiError(err);
    return Response.json(body, { status: code });
  }

  // "project" filters on the normalized key stored on each row, so the query
  // param must go through the same normalizer. A param that normalizes to
  // nothing (garbage, e.g. all punctuation) can never match a stored row —
  // return an empty page rather than 400ing a search filter. The reserved
  // GENERAL_PROJECT_KEY sentinel ("no project set") is recognized as-is: it
  // can never survive normalizeProjectKey (its leading underscore is always
  // converted away), so it has to be checked before that call, not after.
  const projectRaw = searchParams.get("project");
  let project: string | undefined;
  if (projectRaw != null) {
    if (projectRaw === GENERAL_PROJECT_KEY) {
      project = GENERAL_PROJECT_KEY;
    } else {
      try {
        project = normalizeProjectKey(projectRaw) ?? undefined;
      } catch {
        return Response.json({ results: [], limit });
      }
    }
  }

  const results = search(q, { tag, repo, author, status, project, kind, flagged, model, appliesTo, stack }, limit);
  // An agent got these memories: that is a read (lib/learnings.ts touchRead). The web pages never come through here.
  recordSearchRead(results, { status, flagged });

  // verifyHint only when a result is marked verify: true, like bab_search.
  // Nothing found for a real query: name the area contacts, like bab_search.
  const contacts = results.length === 0 && (q.trim() || tag) ? contactsForSearch(q, tag) : [];
  return Response.json({
    results,
    limit,
    ...(contacts.length > 0 ? { contacts, contactsHint: CONTACTS_HINT } : {}),
    ...(results.some((r) => r.verify) ? { verifyHint: VERIFY_HINT } : {}),
  });
}

/** POST /api/learnings — create a learning, then optionally supersede. */
export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "POST", path: "/api/learnings", via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const payload = await req.json().catch(() => null);
      if (!payload || typeof payload !== "object") {
        return { status: 400, body: { error: "Body must be a JSON object" } };
      }

      const title = String((payload as Record<string, unknown>).title ?? "").trim();
      const body = String((payload as Record<string, unknown>).body ?? "").trim();
      if (!title || !body) {
        return { status: 400, body: { error: "title and body are required" } };
      }

      const tagsRaw = (payload as Record<string, unknown>).tags;
      const tags = parseTags(tagsRaw);
      // Redacted, trimmed, de-duplicated and limited by create() (5 x 120); absent keeps a superseded entry's aliases.
      const aliases = parseAliases((payload as Record<string, unknown>).aliases);

      const repoRaw = (payload as Record<string, unknown>).repo;
      const repo = repoRaw == null ? undefined : String(repoRaw);

      const projectRaw = (payload as Record<string, unknown>).project;
      // `_general` is bab_search's spelling of "no project": on a write it means company-wide
      // (null), the same as bab_learn, not the key "general".
      const project = projectRaw == null ? undefined : String(projectRaw) === GENERAL_PROJECT_KEY ? null : String(projectRaw);

      const confidenceRaw = (payload as Record<string, unknown>).confidence;
      if (confidenceRaw != null && !CONFIDENCE_VALUES.includes(confidenceRaw as LearningConfidence)) {
        return { status: 400, body: { error: "confidence must be one of low, medium, high" } };
      }

      const expiresAtRaw = (payload as Record<string, unknown>).expiresAt;
      const neverExpires = typeof expiresAtRaw === "string" && expiresAtRaw.trim().toLowerCase() === "never";
      if (expiresAtRaw != null && !neverExpires && !isCalendarDate(expiresAtRaw)) {
        return { status: 400, body: { error: 'expiresAt must be a real calendar date, YYYY-MM-DD, or "never"' } };
      }

      // One id or a list of ids (a consolidation). The learnings.supersedes_id FK column
      // would reject a bogus id with an opaque constraint error; check every id first so a
      // bad one is a clean 404 and nothing is created or archived.
      const supersedesIds = parseSupersedes((payload as Record<string, unknown>).supersedes);

      const confirmNotDuplicate = (payload as Record<string, unknown>).confirmNotDuplicate === true;
      const provenance = readProvenance(payload as Record<string, unknown>);

      const created = createWithSupersedes({
        authorId: user.id,
        title,
        body,
        tags,
        aliases,
        repo,
        project,
        confidence: confidenceRaw as LearningConfidence | undefined,
        expiresAt: neverExpires ? null : expiresAtRaw ? String(expiresAtRaw) : undefined,
        confirmNotDuplicate,
        // Validated and normalized by create() (a bad id is a 400 through toApiError).
        model: (payload as Record<string, unknown>).model as string | null | undefined,
        // Validated and normalized by create() too (an unknown label is a 400 listing the valid ones).
        appliesTo: (payload as Record<string, unknown>).appliesTo as string[] | string | null | undefined,
        ...provenance,
      }, supersedesIds, "mcp");

      return { status: 201, body: { learning: { ...created, appliesTo: readAppliesTo(created.applies_to) } } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
