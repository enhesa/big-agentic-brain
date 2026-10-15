import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const URL_OK = "claude://code/new?q=Open%20Big%20Agentic%20Brain%20thread%20abc-123";

// No DOM in this suite, and server rendering never runs effects. Run them inline instead, and
// twice, the way React StrictMode does in development, so "once" is actually tested.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (fn: () => void) => {
      fn();
      fn();
    },
  };
});

let assigned: string[];
let replaced: string[];

beforeEach(() => {
  assigned = [];
  replaced = [];
  vi.stubGlobal("window", {
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, url: string) => {
        replaced.push(url);
      },
    },
    location: {
      get href() {
        return "https://bab.example.com/inbox?thread=abc-123&open=app";
      },
      set href(v: string) {
        assigned.push(v);
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function load() {
  return (await import("../app/inbox/AutoOpenApp")).default;
}

describe("AutoOpenApp", () => {
  it("navigates to exactly the given app link, once, even if the effect runs twice", async () => {
    const AutoOpenApp = await load();
    renderToStaticMarkup(<AutoOpenApp url={URL_OK} />);
    expect(assigned).toEqual([URL_OK]);
  });

  it("says it is opening Claude and points at the Continue in Claude app button as the fallback", async () => {
    const AutoOpenApp = await load();
    const html = renderToStaticMarkup(<AutoOpenApp url={URL_OK} />);
    expect(html).toContain("Opening Claude…");
    expect(html).toContain("If nothing happens, use Continue in Claude app below.");
  });

  it("drops open=app from the address before opening, so a reload does not open another session", async () => {
    const AutoOpenApp = await load();
    renderToStaticMarkup(<AutoOpenApp url={URL_OK} />);
    expect(replaced).toEqual(["/inbox?thread=abc-123"]);
  });

  it("refuses anything that is not the claude://code/new app link", async () => {
    const AutoOpenApp = await load();
    for (const bad of [
      "https://evil.example/",
      "javascript:alert(1)",
      "claude-cli://open?q=x",
      "claude://code/other?q=x",
      "//evil.example",
      " claude://code/new?q=x",
      "",
    ]) {
      renderToStaticMarkup(<AutoOpenApp url={bad} />);
    }
    expect(assigned).toEqual([]);
  });
});
