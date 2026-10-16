import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "@/app/components/Markdown";
import { markdownToPlainText, parseInline, parseMarkdown, safeHref } from "@/lib/markdown";
import { renderSnippetHtml } from "@/lib/learnings";

const html = (src: string) => renderToStaticMarkup(<Markdown source={src} />).replace(/ class="[^"]*"/g, "");

describe("markdown: blocks", () => {
  it("renders a paragraph with single newlines as line breaks", () => {
    expect(html("one\ntwo")).toBe("<div><p>one<br/>two</p></div>");
  });

  it("separates paragraphs on a blank line", () => {
    expect(html("one\n\ntwo")).toBe("<div><p>one</p><p>two</p></div>");
  });

  it("starts a list directly under a paragraph line", () => {
    expect(html("Steps:\n- a\n- b")).toBe("<div><p>Steps:</p><ul><li><span>a</span></li><li><span>b</span></li></ul></div>");
  });

  it("renders ordered lists and keeps their start number", () => {
    expect(html("3. c\n4. d")).toBe('<div><ol start="3"><li><span>c</span></li><li><span>d</span></li></ol></div>');
  });

  it("nests an indented list inside its item", () => {
    expect(html("- a\n  - a1\n  - a2\n- b")).toBe(
      "<div><ul><li><span>a</span><ul><li><span>a1</span></li><li><span>a2</span></li></ul></li><li><span>b</span></li></ul></div>",
    );
  });

  it("keeps a loose list together across blank lines", () => {
    const b = parseMarkdown("- a\n\n- b");
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ t: "list", items: [[{ t: "p" }], [{ t: "p" }]] });
  });

  it("maps body headings below the page's own headings", () => {
    expect(html("# Title\n## Sub")).toBe("<div><h3>Title</h3><h4>Sub</h4></div>");
  });

  it("does not treat #hashtag as a heading", () => {
    expect(html("#tag")).toBe("<div><p>#tag</p></div>");
  });

  it("renders fenced code verbatim, with no inline parsing", () => {
    expect(html("```bash\necho **hi** <b>\n```")).toBe(
      '<div><pre data-lang="bash"><code>echo **hi** &lt;b&gt;</code></pre></div>',
    );
  });

  it("closes an unterminated fence at the end of the body", () => {
    expect(parseMarkdown("```\nx")).toEqual([{ t: "pre", lang: null, v: "x" }]);
  });

  it("renders blockquotes, rules and tables", () => {
    expect(html("> quoted\n\n---")).toBe("<div><blockquote><p>quoted</p></blockquote><hr/></div>");
    expect(html("| a | b |\n|---|--:|\n| 1 | `x|y` |")).toBe(
      '<div><div><table><thead><tr><th>a</th><th style="text-align:right">b</th></tr></thead>' +
        '<tbody><tr><td>1</td><td style="text-align:right"><code>x|y</code></td></tr></tbody></table></div></div>',
    );
  });

  it("does not take a line with a pipe for a table without a separator row", () => {
    expect(html("a | b\nc")).toBe("<div><p>a | b<br/>c</p></div>");
  });
});

describe("markdown: inline", () => {
  it("renders bold, italic, strikethrough and code", () => {
    expect(html("**b** *i* _u_ ~~d~~ `c`")).toBe(
      "<div><p><strong>b</strong> <em>i</em> <em>u</em> <del>d</del> <code>c</code></p></div>",
    );
  });

  it("leaves snake_case names alone", () => {
    expect(html("extract_sddr_from_lines and converter_a.py and my__var")).toBe(
      "<div><p>extract_sddr_from_lines and converter_a.py and my__var</p></div>",
    );
  });

  it("leaves a lone asterisk and arithmetic alone", () => {
    expect(html("2 * 3 * 4 and a*")).toBe("<div><p>2 * 3 * 4 and a*</p></div>");
  });

  it("does not parse markers inside code spans", () => {
    expect(html("`**not bold**` and **`code` in bold**")).toBe(
      "<div><p><code>**not bold**</code> and <strong><code>code</code> in bold</strong></p></div>",
    );
  });

  it("supports double-backtick spans that contain a backtick", () => {
    expect(html("``a ` b``")).toBe("<div><p><code>a ` b</code></p></div>");
  });

  it("keeps backslash escapes literal", () => {
    expect(html("\\*not em\\*")).toBe("<div><p>*not em*</p></div>");
  });

  it("links bare URLs without swallowing trailing punctuation", () => {
    expect(html("See https://example.com/a_b.")).toBe(
      '<div><p>See <a href="https://example.com/a_b" target="_blank" rel="noopener noreferrer nofollow">https://example.com/a_b</a>.</p></div>',
    );
    expect(html("(https://example.com/x)")).toContain('href="https://example.com/x"');
  });

  it("renders markdown links and keeps same-site paths in the tab", () => {
    expect(html("[docs](https://example.com) and [memory](/memory/1)")).toBe(
      '<div><p><a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">docs</a> and <a href="/memory/1">memory</a></p></div>',
    );
  });

  it("leaves brackets that are not links as text", () => {
    expect(html("The docx form is [green/gray] - Low")).toBe("<div><p>The docx form is [green/gray] - Low</p></div>");
  });
});

describe("markdown: safety", () => {
  it("shows raw HTML as text", () => {
    const out = html('<img src=x onerror="alert(1)"><script>alert(1)</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  it("never links javascript:, data: or protocol-relative targets, and shows them as text", () => {
    for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "//evil.example", "/\\evil.example", "vbscript:x"]) {
      const out = html(`[click](${href})`);
      expect(out).not.toContain("<a");
      expect(out).toContain("[click](");
    }
    expect(safeHref(" javascript:alert(1)")).toBeNull();
  });

  it("renders an image as a link, never an <img>", () => {
    expect(html("![diagram](https://example.com/d.png)")).toBe(
      '<div><p><a href="https://example.com/d.png" target="_blank" rel="noopener noreferrer nofollow">diagram</a></p></div>',
    );
  });

  it("survives deep nesting and pathological input without throwing", () => {
    expect(() => html("> ".repeat(200) + "deep")).not.toThrow();
    expect(() => html("- ".repeat(200) + "deep")).not.toThrow();
    expect(() => parseInline("*".repeat(5000))).not.toThrow();
    expect(() => html("[".repeat(3000) + "x")).not.toThrow();
    const start = performance.now();
    html("**a ".repeat(2000));
    html("`".repeat(4000));
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("markdown: review edge cases", () => {
  it("renders ***both*** as bold italic", () => {
    expect(html("***both***")).toBe("<div><p><strong><em>both</em></strong></p></div>");
  });

  it("keeps code-like text that looks like a link with an unsafe target", () => {
    expect(html("call handlers[name](ctx) now")).toBe("<div><p>call handlers[name](ctx) now</p></div>");
  });

  it("keeps backslashes in Windows paths", () => {
    expect(html("C:\\Program Files\\(x86) and ~\\.claude")).toBe("<div><p>C:\\Program Files\\(x86) and ~\\.claude</p></div>");
  });

  it("drops an unmatched closing bracket from a bare URL", () => {
    expect(html("[see https://a.example/x]")).toContain('href="https://a.example/x"');
    expect(html("https://en.wikipedia.org/wiki/Foo_(bar)")).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
  });

  it("does not start an ordered list mid-paragraph unless it counts from 1", () => {
    expect(html("fixed in version\n2024. Then more")).toBe("<div><p>fixed in version<br/>2024. Then more</p></div>");
    expect(html("Steps:\n1. a\n2. b")).toContain("<ol>");
  });

  it("keeps a fenced block with blank lines inside its list item", () => {
    const b = parseMarkdown("- item\n  ```\n  a\n\nb\n  ```\n- next");
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ t: "list", items: [[{ t: "p" }, { t: "pre", v: "a\n\nb" }], [{ t: "p" }]] });
  });

  it("treats an item indented by one space as a sibling", () => {
    expect(html("- a\n - b")).toBe("<div><ul><li><span>a</span></li><li><span>b</span></li></ul></div>");
  });

  it("keeps emphasis inside deeply nested lists", () => {
    expect(html("- a\n  - b\n    - c\n      - d\n        - e\n          - f\n            - **g**")).toContain("<strong>g</strong>");
  });

  it("does not link to the API, where a GET can change state", () => {
    expect(html("[x](/api/inbox/1)")).toBe("<div><p>[x](/api/inbox/1)</p></div>");
    expect(html("[x](/apis-guide)")).toContain('href="/apis-guide"');
  });

  it("trims a URL followed by thousands of closers in linear time", () => {
    const start = performance.now();
    html("http://a" + ")".repeat(7990));
    html("http://a" + ".".repeat(7990));
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("markdown: the body from a real memory", () => {
  const body = [
    "SciveraLENS can export an SDDR as markdown (SVID-xxxx_sddr_<timestamp>.md). Its layout differs from the .docx text that converter_a.py's extract_sddr_from_lines parses, so feeding it straight in gives 0 endpoints, with no error:",
    "- endpoint headings are `### Human - HHc - Carcinogenicity` with a blank line after",
    "- the score sits on the same line: `**Hazard Assessment:** green/gray (le) - Low Hazard`. The docx form is `[green/gray] - Low Hazard...`",
    "- drivers are a `(Driver)` suffix on the bullet (`- Carcinogenicity Data: low  (Driver)`), not a leading `*`",
    "",
    "Fix: detect `**Hazard Assessment:**` and rewrite the markdown first.",
  ].join("\n");

  it("renders the list, the code spans and the names intact", () => {
    const out = html(body);
    expect(out).toContain("SVID-xxxx_sddr_&lt;timestamp&gt;.md");
    expect(out).toContain("converter_a.py&#x27;s extract_sddr_from_lines");
    expect(out.match(/<li>/g)).toHaveLength(3);
    expect(out).toContain("<code>**Hazard Assessment:** green/gray (le) - Low Hazard</code>");
    expect(out).toContain("<code>- Carcinogenicity Data: low  (Driver)</code>");
    expect(out).toContain("not a leading <code>*</code>");
    expect(out).not.toContain("<strong>");
  });
});

describe("markdown: plain text for previews", () => {
  it("drops markers and keeps the words", () => {
    expect(markdownToPlainText("# Title\n\n- **bold** and `code`\n- [link](https://x.example)")).toBe("Title bold and code link");
  });

  it("strips bold and code markers from a search snippet but still escapes it", () => {
    expect(renderSnippetHtml("## Fix **this** `now` <b>")).toBe("Fix this now &lt;b&gt;");
  });
});
