import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { audit } from "./audit";
import { emit } from "./events";
import { redact, assertMaxLength, assertRawLength } from "./redact";
import { addDaysUtc, todayUtc } from "./dates";
import { NotFoundError, ConflictError } from "./errors";
import type { AuditVia, TodoRow } from "./types";

const SNOOZE_DAYS = 7;
const TITLE_MAX = 160;
const BODY_MAX = 4000;
const RELATED_KEY_MAX = 80;
/** due_soon window, in days (inclusive of today): used by GET /api/todos?tab=due_soon. */
export const DUE_SOON_DAYS = 14;

export interface CreateTodoInput {
  ownerId: string;
  title: string;
  body?: string | null;
  dueAt?: string | null;
  relatedKey?: string | null;
}

export function create(input: CreateTodoInput, via: AuditVia = "ui"): TodoRow {
  const db = getDb();
  const id = randomUUID();

  assertRawLength("title", input.title, TITLE_MAX);
  if (input.body != null) assertRawLength("body", input.body, BODY_MAX);
  if (input.relatedKey != null) assertRawLength("relatedKey", input.relatedKey, RELATED_KEY_MAX);
  const title = redact(input.title.trim());
  assertMaxLength("title", title, TITLE_MAX);

  const body = input.body != null ? redact(input.body.trim()) : null;
  if (body) assertMaxLength("body", body, BODY_MAX);

  const relatedKey = input.relatedKey != null ? redact(input.relatedKey.trim()) : null;
  if (relatedKey) assertMaxLength("relatedKey", relatedKey, RELATED_KEY_MAX);

  db.prepare(
    `INSERT INTO todos (id, owner_id, title, body, due_at, status, related_key)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
  ).run(id, input.ownerId, title, body, input.dueAt ?? null, relatedKey);

  audit(db, input.ownerId, "create", "todo", id, via);
  // No title: reminders are private and /api/events is public (review, 2026-10-01).
  emit("todo.changed", id, { id, kind: "open" });

  return getById(id)!;
}

export function getById(id: string): TodoRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM todos WHERE id = ?").get(id) as unknown as | TodoRow
    | undefined;
}

export const TODO_TABS = ["overdue", "due_soon", "open", "done"] as const;
export type TodoFilter = (typeof TODO_TABS)[number];

/**
 * due_at is a UTC calendar date ("YYYY-MM-DD"); overdue/due_soon are computed
 * against today's UTC calendar date. Older rows may still hold a full ISO
 * datetime, so comparisons use substr(due_at, 1, 10) to stay tolerant of that.
 */
export function listMine(ownerId: string, filter: TodoFilter = "open"): TodoRow[] {
  const db = getDb();
  const today = todayUtc();

  if (filter === "overdue") {
    return db
      .prepare(
        "SELECT * FROM todos WHERE owner_id = ? AND status = 'open' AND due_at IS NOT NULL AND substr(due_at, 1, 10) < ? ORDER BY due_at ASC",
      )
      .all(ownerId, today) as unknown as TodoRow[];
  }

  if (filter === "due_soon") {
    const windowEnd = addDaysUtc(today, DUE_SOON_DAYS);
    return db
      .prepare(
        "SELECT * FROM todos WHERE owner_id = ? AND status = 'open' AND due_at IS NOT NULL AND substr(due_at, 1, 10) >= ? AND substr(due_at, 1, 10) <= ? ORDER BY due_at ASC",
      )
      .all(ownerId, today, windowEnd) as unknown as TodoRow[];
  }

  if (filter === "done") {
    return db
      .prepare(
        "SELECT * FROM todos WHERE owner_id = ? AND status IN ('done', 'abandoned') ORDER BY updated_at DESC",
      )
      .all(ownerId) as unknown as TodoRow[];
  }

  // "open": all open todos (any due date, including none)
  return db
    .prepare(
      "SELECT * FROM todos WHERE owner_id = ? AND status = 'open' ORDER BY due_at IS NULL, due_at ASC, created_at DESC",
    )
    .all(ownerId) as unknown as TodoRow[];
}

// Ownership is enforced by the WHERE clause itself, not a separate lookup: a
// wrong-owner attempt reads as "not found" rather than 403, same as before —
// it doesn't leak whether the id exists to someone who doesn't own it.

export function complete(id: string, actorId: string, via: AuditVia = "ui"): TodoRow {
  const db = getDb();
  const todo = getById(id);
  if (!todo || todo.owner_id !== actorId) throw new NotFoundError("Reminder not found");
  if (todo.status === "done" || todo.status === "abandoned") {
    throw new ConflictError(`Reminder is already ${todo.status}`);
  }

  const result = db.prepare(
    "UPDATE todos SET status = 'done', updated_at = datetime('now') WHERE id = ? AND owner_id = ?",
  ).run(id, actorId);
  if (result.changes === 0) throw new NotFoundError("Reminder not found");
  audit(db, actorId, "complete", "todo", id, via);
  emit("todo.changed", id, { id, kind: "done" });
  return getById(id)!;
}

export function snooze(id: string, actorId: string, via: AuditVia = "ui"): TodoRow {
  const db = getDb();
  const todo = getById(id);
  if (!todo || todo.owner_id !== actorId) throw new NotFoundError("Reminder not found");
  if (todo.status === "done") {
    throw new ConflictError("Reminder is already done");
  }

  // From the later of today and the due date: snoozing a reminder that is already
  // overdue must push it past today, not just a week past its old date (review,
  // 2026-09-25), matching bab_remind's own description.
  const today = todayUtc();
  const due = todo.due_at ? todo.due_at.slice(0, 10) : today;
  const base = due > today ? due : today;
  const newDueAt = addDaysUtc(base, SNOOZE_DAYS);

  const result = db.prepare(
    "UPDATE todos SET status = 'open', due_at = ?, updated_at = datetime('now') WHERE id = ? AND owner_id = ?",
  ).run(newDueAt, id, actorId);
  if (result.changes === 0) throw new NotFoundError("Reminder not found");
  audit(db, actorId, "snooze", "todo", id, via);
  emit("todo.changed", id, { id, kind: "snoozed" });
  return getById(id)!;
}

export function abandon(id: string, actorId: string, via: AuditVia = "ui"): TodoRow {
  const db = getDb();
  const todo = getById(id);
  if (!todo || todo.owner_id !== actorId) throw new NotFoundError("Reminder not found");
  if (todo.status === "done" || todo.status === "abandoned") {
    throw new ConflictError(`Reminder is already ${todo.status}`);
  }

  const result = db.prepare(
    "UPDATE todos SET status = 'abandoned', updated_at = datetime('now') WHERE id = ? AND owner_id = ?",
  ).run(id, actorId);
  if (result.changes === 0) throw new NotFoundError("Reminder not found");
  audit(db, actorId, "abandon", "todo", id, via);
  emit("todo.changed", id, { id, kind: "abandoned" });
  return getById(id)!;
}
