import { describe, it, expect } from "vitest";
import { api, ALICE, BOB, uniqueTitle } from "./helpers";

function isoDatePlusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("e2e: todos", () => {
  it("creates a todo: 201", async () => {
    const res = await api("/api/todos", {
      method: "POST",
      actor: ALICE,
      body: { title: uniqueTitle("Todo"), dueAt: isoDatePlusDays(3) },
    });
    expect(res.status).toBe(201);
  });

  it("due_soon includes a todo due in 10 days", async () => {
    const create = await api("/api/todos", {
      method: "POST",
      actor: ALICE,
      body: { title: uniqueTitle("Due soon todo"), dueAt: isoDatePlusDays(10) },
    });
    const { todo } = await create.json();

    const due = await api("/api/todos?tab=due_soon", { actor: ALICE });
    expect(due.status).toBe(200);
    const { todos } = await due.json();
    expect(todos.find((t: { id: string }) => t.id === todo.id)).toBeTruthy();
  });

  it("complete, then complete again 409s", async () => {
    const create = await api("/api/todos", {
      method: "POST",
      actor: ALICE,
      body: { title: uniqueTitle("Complete me"), dueAt: isoDatePlusDays(1) },
    });
    const { todo } = await create.json();

    const first = await api(`/api/todos/${todo.id}/complete`, { method: "POST", actor: ALICE });
    expect(first.status).toBe(200);

    const second = await api(`/api/todos/${todo.id}/complete`, { method: "POST", actor: ALICE });
    expect(second.status).toBe(409);
  });

  it("cross-owner access is rejected (404 or 403)", async () => {
    const create = await api("/api/todos", {
      method: "POST",
      actor: ALICE,
      body: { title: uniqueTitle("Alice's private todo"), dueAt: isoDatePlusDays(2) },
    });
    const { todo } = await create.json();

    const res = await api(`/api/todos/${todo.id}/complete`, { method: "POST", actor: BOB });
    expect([403, 404]).toContain(res.status);
  });
});
