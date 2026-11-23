import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The release workflow pushes the container image to a public registry. That job must run only
 * for a release that was just created, with the narrowest rights that can push a package, and it
 * must refuse a tag that is not a plain version: the tag becomes part of the image name.
 */
describe("release workflow: the image job", () => {
  const text = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "release.yml"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  /** The text of one top-level job: from its `  name:` line to the next job or the end. */
  function job(name: string): string {
    const start = text.indexOf(`\n  ${name}:\n`);
    expect(start, `job ${name}`).toBeGreaterThan(-1);
    const rest = text.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  }

  const image = job("image");

  it("runs only after a release was created", () => {
    expect(image).toMatch(/\n    needs: release-please\n/);
    expect(image).toMatch(/\n    if: needs\.release-please\.outputs\.released == 'true'\n/);
    expect(job("release-please")).toContain(
      "released: ${{ steps.release.outputs.release_created }}",
    );
  });

  it("may read the code and write packages, nothing else", () => {
    const rights = image.match(/\n    permissions:\n((?:      .+\n)+)/);
    expect(rights).not.toBeNull();
    const lines = rights![1].trim().split("\n").map((line) => line.trim());
    expect(lines.sort()).toEqual(["contents: read", "packages: write"]);
  });

  it("builds from the release tag without keeping credentials", () => {
    expect(image).toContain("ref: ${{ needs.release-please.outputs.tag }}");
    expect(image).toContain("persist-credentials: false");
  });

  it("refuses a tag that is not a plain version", () => {
    expect(image).toContain('[[ "$version" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]');
    // The tag reaches the shell as an environment variable, never pasted into the script.
    expect(image).toContain("TAG: ${{ needs.release-please.outputs.tag }}");
    const script = image.slice(image.indexOf("run: |"), image.indexOf("docker/setup-qemu-action"));
    expect(script).not.toContain("${{");
  });

  it("publishes both platforms under the version, the minor line and latest", () => {
    expect(image).toContain("platforms: linux/amd64,linux/arm64");
    expect(image).toContain("push: true");
    expect(image).toContain('list=$image:$version,$image:${version%.*},$image:latest');
  });
});
