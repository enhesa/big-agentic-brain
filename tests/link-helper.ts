/**
 * Test setup only: writes a forge_links row directly, the way a finished link looks,
 * so tests that need an already-linked browser do not depend on a particular link flow.
 */
export async function linkForTests(forgeUserId: string, email: string): Promise<void> {
  const { getDb } = await import("../lib/db");
  getDb()
    .prepare("INSERT INTO forge_links (forge_user_id, user_id, linked_at) VALUES (?, ?, datetime('now'))")
    .run(forgeUserId, email);
}
