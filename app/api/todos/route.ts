import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { listMine, create, TODO_TABS, type TodoFilter } from "@/lib/todos";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";
import { isCalendarDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

const TAB_VALUES: readonly TodoFilter[] = TODO_TABS;

/** GET /api/todos?tab=overdue|due_soon|open|done — my reminders. */
export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "GET", path: "/api/todos", via: "mcp" });

  const { searchParams } = new URL(req.url);
  const tabRaw = searchParams.get("tab");
  if (tabRaw != null && !TAB_VALUES.includes(tabRaw as TodoFilter)) {
    return Response.json({ error: `tab must be one of ${TAB_VALUES.join(", ")}` }, { status: 400 });
  }
  const tab = (tabRaw ?? "open") as TodoFilter;

  const todos = listMine(user.id, tab);
  return Response.json({ todos });
}

/** POST /api/todos — { title, dueAt, body?, relatedKey? } */
export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "POST", path: "/api/todos", via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const payload = await req.json().catch(() => null);
      if (!payload || typeof payload !== "object") {
        return { status: 400, body: { error: "Body must be a JSON object" } };
      }
      const record = payload as Record<string, unknown>;

      const title = String(record.title ?? "").trim();
      if (!title) return { status: 400, body: { error: "title is required" } };

      const dueAtRaw = record.dueAt;
      if (dueAtRaw == null || dueAtRaw === "") {
        return { status: 400, body: { error: "dueAt is required and must be a real calendar date, YYYY-MM-DD" } };
      }
      if (!isCalendarDate(dueAtRaw)) {
        return { status: 400, body: { error: "dueAt must be a real calendar date, YYYY-MM-DD" } };
      }

      const body = record.body == null ? null : String(record.body);
      const relatedKey = record.relatedKey == null ? null : String(record.relatedKey);

      const todo = create({ ownerId: user.id, title, dueAt: dueAtRaw, body, relatedKey }, "mcp");
      return { status: 201, body: { todo } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
