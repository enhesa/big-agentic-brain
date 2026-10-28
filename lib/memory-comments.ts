import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { audit } from "./audit";
import { emit } from "./events";
import { redact } from "./redact";
import { getById } from "./learnings";
import { isMaintainer } from "./feedback";
import { ForbiddenError, NotFoundError, TooManyRequestsError, ValidationError } from "./errors";
import type { AuditVia } from "./types";

/**
 * Comments on memories (migration v50): colleagues add context to a memory, from its page or with
 * bab_react comment. Plain text, trimmed and redacted like a memory body. Anyone may comment,
 * the memory's author too. The author of a comment edits or deletes it; a maintainer may delete any.
 * A delete is soft: the row stays as "comment removed" and its body is blanked, so text that should
 * not have been shared is gone. Comments are not in the search index (docs/spec.md "Comments").
 */

export const MEMORY_COMMENT_MAX = 2000;
/** Comments one person may post in a day, across all memories: a loop cannot flood a page. */
export const MEMORY_COMMENT_DAILY_LIMIT = 50;
/** bab_search shows this many of a memory's newest comments. */
export const SEARCH_COMMENTS_LATEST = 3;
/** bab_search cuts each comment body to this many characters. */
export const SEARCH_COMMENT_CUT = 300;

export interface MemoryComment {
  id: string;
  learningId: string;
  authorId: string;
  authorName: string | null;
  /** null once deleted: the page shows "comment removed". */
  body: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

interface CommentRow {
  id: string;
  learning_id: string;
  author_id: string;
  author_name: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

function toComment(r: CommentRow): MemoryComment {
  return {
    id: r.id,
    learningId: r.learning_id,
    authorId: r.author_id,
    authorName: r.author_name,
    body: r.deleted_at ? null : r.body,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
  };
}

/**
 * A comment body from a form field or tool argument: text, trimmed, redacted, not empty and at most
 * MEMORY_COMMENT_MAX characters, before and after redaction. Exported so the page's vote-plus-comment
 * post can check the comment before it records the vote.
 */
export function cleanCommentBody(raw: unknown): string {
  if (raw == null) throw new ValidationError("comment is required");
  if (typeof raw !== "string") throw new ValidationError("comment must be text");
  const trimmed = raw.trim();
  if (!trimmed) throw new ValidationError("comment is required");
  if (trimmed.length > MEMORY_COMMENT_MAX) throw new ValidationError(`comment must be ${MEMORY_COMMENT_MAX} characters or fewer`);
  const body = redact(trimmed).trim();
  if (!body) throw new ValidationError("comment is required");
  if (body.length > MEMORY_COMMENT_MAX) throw new ValidationError(`comment must be ${MEMORY_COMMENT_MAX} characters or fewer`);
  return body;
}

/** Refuses a person who already posted MEMORY_COMMENT_DAILY_LIMIT comments in the last 24 hours. */
export function assertMayComment(authorId: string): void {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM memory_comments WHERE author_id = ? AND created_at >= datetime('now', '-1 day')")
    .get(authorId) as { n: number };
  if (Number(row.n) >= MEMORY_COMMENT_DAILY_LIMIT) {
    throw new TooManyRequestsError(`Daily comment limit reached (${MEMORY_COMMENT_DAILY_LIMIT}): try again tomorrow`);
  }
}

function requireLiveLearning(learningId: string) {
  const learning = getById(learningId);
  if (!learning || learning.status === "deleted") throw new NotFoundError("Learning not found");
  return learning;
}

function getComment(id: string): MemoryComment | undefined {
  const row = getDb()
    .prepare(
      `SELECT c.*, u.name AS author_name FROM memory_comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.id = ?`,
    )
    .get(id) as CommentRow | undefined;
  return row ? toComment(row) : undefined;
}

/** Posts a comment on a live (active or archived) memory. Audited as comment, entity memory_comment. */
export function addComment(learningId: string, authorId: string, raw: unknown, via: AuditVia = "ui"): MemoryComment {
  const learning = requireLiveLearning(learningId);
  const body = cleanCommentBody(raw);
  assertMayComment(authorId);
  const db = getDb();
  const id = randomUUID();
  db.prepare("INSERT INTO memory_comments (id, learning_id, author_id, body) VALUES (?, ?, ?, ?)").run(id, learningId, authorId, body);
  audit(db, authorId, "comment", "memory_comment", id, via, { details: { learningId } });
  // Ids and the memory title only: /api/events is public.
  emit("learning.updated", learningId, { id: learningId, title: learning.title, kind: "comment" });
  return getComment(id)!;
}

/** The comment, when it belongs to this memory and is not deleted. */
function requireOpenComment(learningId: string, commentId: string): MemoryComment {
  const c = getComment(commentId);
  if (!c || c.learningId !== learningId || c.deletedAt) throw new NotFoundError("Comment not found");
  requireLiveLearning(learningId);
  return c;
}

/** The author changes their own comment. `changed` is false when the text is the same. */
export function editComment(
  learningId: string,
  commentId: string,
  actorId: string,
  raw: unknown,
  via: AuditVia = "ui",
): { comment: MemoryComment; changed: boolean } {
  const c = requireOpenComment(learningId, commentId);
  if (c.authorId !== actorId) throw new ForbiddenError("Only its author can edit a comment");
  const body = cleanCommentBody(raw);
  if (body === c.body) return { comment: c, changed: false };
  const db = getDb();
  db.prepare("UPDATE memory_comments SET body = ?, edited_at = datetime('now') WHERE id = ?").run(body, commentId);
  audit(db, actorId, "comment_edit", "memory_comment", commentId, via, { details: { learningId } });
  emit("learning.updated", learningId, { id: learningId, kind: "comment" });
  return { comment: getComment(commentId)!, changed: true };
}

/** The author, or a maintainer, removes a comment: soft, the body is blanked. */
export function removeComment(learningId: string, commentId: string, actorId: string, via: AuditVia = "ui"): MemoryComment {
  const c = requireOpenComment(learningId, commentId);
  if (c.authorId !== actorId && !isMaintainer(actorId)) {
    throw new ForbiddenError("Only its author or a maintainer can delete a comment");
  }
  const db = getDb();
  db.prepare("UPDATE memory_comments SET body = '', deleted_at = datetime('now') WHERE id = ?").run(commentId);
  audit(db, actorId, "comment_delete", "memory_comment", commentId, via, {
    details: { learningId, ...(c.authorId !== actorId ? { authorId: c.authorId } : {}) },
  });
  emit("learning.updated", learningId, { id: learningId, kind: "comment" });
  return getComment(commentId)!;
}

/** Every comment on a memory, oldest first, removed ones included (as body null). */
export function commentsFor(learningId: string): MemoryComment[] {
  const rows = getDb()
    .prepare(
      `SELECT c.*, u.name AS author_name FROM memory_comments c LEFT JOIN users u ON u.id = c.author_id
       WHERE c.learning_id = ? ORDER BY c.created_at, c.rowid`,
    )
    .all(learningId) as unknown as CommentRow[];
  return rows.map(toComment);
}

export interface CommentDigest {
  /** Comments that are not removed. */
  count: number;
  /** The newest SEARCH_COMMENTS_LATEST, newest first, each body cut to SEARCH_COMMENT_CUT characters. */
  latest: Array<{ authorName: string; at: string; body: string }>;
}

function cut(text: string, max: number): string {
  // By code point, so a cut never splits a surrogate pair.
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * For bab_search and GET /api/learnings/[id]: per memory with at least one comment, the count and
 * the newest few. One query for all ids. Memories with no comments are absent from the map.
 */
export function commentDigestFor(learningIds: string[]): Map<string, CommentDigest> {
  const out = new Map<string, CommentDigest>();
  const ids = [...new Set(learningIds)];
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT learning_id, author_id, author_name, body, created_at, n, rn FROM (
         SELECT c.learning_id, c.author_id, u.name AS author_name, c.body, c.created_at,
                ROW_NUMBER() OVER (PARTITION BY c.learning_id ORDER BY c.created_at DESC, c.rowid DESC) AS rn,
                COUNT(*) OVER (PARTITION BY c.learning_id) AS n
         FROM memory_comments c LEFT JOIN users u ON u.id = c.author_id
         WHERE c.learning_id IN (${marks}) AND c.deleted_at IS NULL
       ) WHERE rn <= ? ORDER BY learning_id, rn`,
    )
    .all(...ids, SEARCH_COMMENTS_LATEST) as Array<{
    learning_id: string;
    author_id: string;
    author_name: string | null;
    body: string;
    created_at: string;
    n: number;
  }>;
  for (const r of rows) {
    let d = out.get(r.learning_id);
    if (!d) {
      d = { count: Number(r.n), latest: [] };
      out.set(r.learning_id, d);
    }
    d.latest.push({ authorName: r.author_name ?? r.author_id, at: r.created_at, body: cut(r.body, SEARCH_COMMENT_CUT) });
  }
  return out;
}

/**
 * For the author nudge in app/api/hook: the author's live memories that someone else commented on
 * in the last `days` days, with the UTC day of the newest such comment (the dedup key, so the author
 * hears about a memory at most once a day). Oldest first.
 */
export function commentedOwnMemories(authorId: string, days: number): Array<{ id: string; title: string; day: string }> {
  return getDb()
    .prepare(
      `SELECT l.id AS id, l.title AS title, date(MAX(c.created_at)) AS day
       FROM memory_comments c JOIN learnings l ON l.id = c.learning_id
       WHERE l.author_id = ? AND c.author_id != l.author_id AND c.deleted_at IS NULL AND l.status != 'deleted'
         AND c.created_at > datetime('now', ?)
       GROUP BY l.id ORDER BY MAX(c.created_at)`,
    )
    .all(authorId, `-${days} days`) as Array<{ id: string; title: string; day: string }>;
}
