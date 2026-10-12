/**
 * Helpers for the /me/devices routes. The pages work without client JS, so their
 * writes arrive as plain HTML form posts (urlencoded or multipart); a JSON caller is served
 * too. Both are cookie-authenticated, so every route also checks sameOrigin
 * (lib/feedback-web.ts): a form on another site sends its own Origin and is refused.
 */

export function wantsJson(request: Request): boolean {
  return (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}

/** String fields of a form or JSON body; anything else is dropped. Never throws. */
export async function readFields(request: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    if (wantsJson(request)) {
      const body = (await request.json()) as unknown;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
      }
    } else {
      const form = await request.formData();
      for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
    }
  } catch {
    // An unreadable body is an empty one; the caller's validation says what is missing.
  }
  return out;
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
