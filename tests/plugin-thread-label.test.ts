import { describe, it, expect } from "vitest";
import { groupLabel, groupOthers } from "../plugins/claude-code/hooks/thread-label";
import { groupOutgoingStatus } from "../lib/delivery";

const ME = "me@example.com";

describe("inbox panel thread labels", () => {
  it("treats a thread with more than one other participant as a group", () => {
    const t = { participants: [{ id: "a@example.com" }, { id: ME }, { id: "b@example.com" }] };
    expect(groupOthers(t, ME)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("is not a group for a 1:1 thread, a note to self, or an older server with no participants", () => {
    expect(groupOthers({ participants: [{ id: ME }, { id: "a@example.com" }] }, ME)).toEqual([]);
    expect(groupOthers({ participants: [{ id: ME }] }, ME)).toEqual([]);
    expect(groupOthers({ lastMessage: { from_id: "a@example.com", to_id: ME } }, ME)).toEqual([]);
  });

  it("ignores junk entries and duplicates", () => {
    const t = { participants: [{ id: "a@example.com" }, {}, { id: "" }, { id: "a@example.com" }, { id: "b@example.com" }] };
    expect(groupOthers(t, ME)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("names two people in full and more with a count", () => {
    expect(groupLabel(["Bob", "Carol"])).toBe("Bob, Carol");
    expect(groupLabel(["Bob", "Carol", "Dave", "Eve"])).toBe("Bob, Carol +2");
  });
});

describe("groupOutgoingStatus", () => {
  it("says who read a group message, never who did not", () => {
    expect(groupOutgoingStatus({ readers: [], total: 3, page: "none" })).toBe("None of the 3 recipients has read your last message yet.");
    expect(groupOutgoingStatus({ readers: ["Bob"], total: 3, page: "none" })).toBe("Bob read your last message; 2 of 3 have not yet.");
    expect(groupOutgoingStatus({ readers: ["Bob", "Carol"], total: 2, page: "connected" })).toBe(
      "All 2 recipients read your last message. At least one of their Inboxes is open.",
    );
  });
});
