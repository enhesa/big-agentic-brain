import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToReadableStream } from "react-dom/server.edge";
import { renderToStaticMarkup } from "react-dom/server";
import { _resetConfigForTests } from "@/lib/config";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bab-branding-"));

const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) {
  if (!(k in saved)) saved[k] = process.env[k];
  process.env[k] = v;
  _resetConfigForTests();
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
  _resetConfigForTests();
});

beforeAll(() => _resetConfigForTests());

async function renderHome(): Promise<string> {
  const { default: Home } = await import("../app/page");
  // React separates adjacent text nodes with comment markers; drop them so assertions read as text.
  return (await new Response(await renderToReadableStream(<Home />)).text()).replace(/<!-- -->/g, "");
}

describe("branding", () => {
  it("landing renders orgName in topbar, hero, footer and FAQ", async () => {
    setEnv("BAB_ORG_NAME", "Zeta");
    const html = await renderHome();
    expect(html).toContain('alt="Zeta"');
    expect(html).toContain("One shared memory for every Zeta agent");
    expect(html).toContain("A shared memory for Zeta&#x27;s AI agents");
    expect(html).toContain("Zeta \u00a9 " + new Date().getFullYear());
    expect(html.match(/Zeta/g)!.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain("Acme");
    expect(html).not.toContain("VPN");
  });

  it("orgName is escaped", async () => {
    setEnv("BAB_ORG_NAME", "<script>x</script>");
    const html = await renderHome();
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });

  it("install commands use configured marketplace", async () => {
    setEnv("BAB_PLUGIN_MARKETPLACE", "zeta/plugins");
    setEnv("BAB_PLUGIN_MARKETPLACE_NAME", "zeta-plugins");
    const html = await renderHome();
    expect(html).toContain("/plugin marketplace add zeta/plugins");
    expect(html).toContain("/plugin install bab@zeta-plugins");
    expect(html).not.toContain("acme-plugins");
  });

  it("shows no install screenshot unless one is configured", async () => {
    const html = await renderHome();
    expect(html).not.toContain("Prefer the terminal?");
    expect(html).toContain("Two commands");
    expect(html).not.toMatch(/<img[^>]+\/branding\/install/);
  });

  it("shows the configured install screenshot above the commands, with its alt text escaped", async () => {
    setEnv("BAB_INSTALL_SCREENSHOT", "/branding/install.png");
    setEnv("BAB_INSTALL_SCREENSHOT_ALT", 'Step 1: open "Customize" <then> add');
    const html = await renderHome();
    expect(html).toContain('src="/branding/install.png"');
    expect(html).toContain('alt="Step 1: open &quot;Customize&quot; &lt;then&gt; add"');
    expect(html).toContain("Prefer the terminal?");
    expect(html.indexOf('src="/branding/install.png"')).toBeLessThan(html.indexOf("/plugin marketplace add"));
  });

  it("refuses an install screenshot that is not a site path or an https URL", async () => {
    const { config } = await import("@/lib/config");
    for (const bad of ["javascript:alert(1)", "http://example.com/x.png", "//evil.example/x.png", "install.png"]) {
      setEnv("BAB_INSTALL_SCREENSHOT", bad);
      expect(() => config(), bad).toThrow(/BAB_INSTALL_SCREENSHOT/);
    }
    setEnv("BAB_INSTALL_SCREENSHOT", "https://cdn.example.com/install.png");
    expect(config().branding.installScreenshot).toBe("https://cdn.example.com/install.png");
  });

  it("layout emits accent style and branding icon links", async () => {
    setEnv("BAB_ACCENT_COLOR", "#1a3360");
    const { default: RootLayout, generateMetadata, dynamic } = await import("../app/layout");
    expect(dynamic).toBe("force-dynamic");
    expect((await generateMetadata()).title).toBe("Big Agentic Brain");
    const html = renderToStaticMarkup(RootLayout({ children: <div /> }));
    expect(html).toContain(":root{--accent:#1a3360;--accent-soft:#1a33601f}");
    expect(html).toContain('href="/branding/icon.svg"');
    expect(html).toContain('href="/branding/favicon.ico"');
    expect(html).toContain('href="/branding/apple-icon.png"');
    expect(html).not.toContain("fonts.googleapis.com");
  });

  it("formatDate honours BAB_TIMEZONE", async () => {
    setEnv("BAB_TIMEZONE", "Europe/Brussels");
    setEnv("BAB_LOCALE", "en-GB");
    const { formatDate } = await import("@/lib/branding");
    expect(formatDate(new Date("2026-01-01T23:30:00Z"))).toBe("02/01/2026");
  });
});
