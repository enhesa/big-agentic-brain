import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * docker-compose.yml is the quickstart, and it runs open (no proxy identity, no tokens), so its
 * published port must stay on the loopback address: anyone who can reach an open BAB can read and
 * write every memory. Changing the binding is the operator's choice once identity is set up
 * (docs/deploy/compose.md), never the default.
 */
describe("docker-compose.yml", () => {
  const text = readFileSync(path.join(process.cwd(), "docker-compose.yml"), "utf8");

  /** Every entry of every `ports:` list, quotes stripped. */
  function publishedPorts(): string[] {
    const lines = text.split(/\r?\n/);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*ports:\s*$/.test(lines[i])) continue;
      const indent = lines[i].match(/^\s*/)![0].length;
      for (let j = i + 1; j < lines.length; j++) {
        const entry = lines[j].match(/^(\s*)-\s*(.+?)\s*$/);
        if (!entry || entry[1].length < indent) break;
        out.push(entry[2].replace(/^["']|["']$/g, ""));
      }
    }
    return out;
  }

  it("publishes at least one port", () => {
    expect(publishedPorts().length).toBeGreaterThan(0);
  });

  it("publishes every port on 127.0.0.1 only", () => {
    for (const port of publishedPorts()) expect(port).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
  });
});
