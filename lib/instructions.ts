import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { branding } from "./branding";
import { platformLabels } from "./applies-to";
import { teamTags } from "./teams";
import { identityDomain, identityHint } from "./identity";
import { config } from "./config";

const contentDir = path.join(process.cwd(), "content", "instructions");

const rawInstall = readFileSync(path.join(contentDir, "install.md"), "utf8");
const rawSkill = readFileSync(path.join(contentDir, "skill.md"), "utf8");

const PLACEHOLDER_RE =
  /\{\{(ORIGIN|ORG_NAME|IDENTITY_HINT|IDENTITY_DOMAIN|MARKETPLACE|MARKETPLACE_NAME|ALLOWED_SENDERS|PLIST_ID|PLATFORM_LABELS|TEAM_TAGS|FILES_LIMITS)\}\}|<origin>|__BAB_ORIGIN__/g;

/** Replaces every placeholder with the current configuration. `origin` null leaves the origin placeholders in place. */
export function renderInstructionText(text: string, origin: string | null): string {
  const b = branding();
  const domain = identityDomain();
  const values: Record<string, string> = {
    "{{ORG_NAME}}": b.orgName,
    "{{IDENTITY_HINT}}": identityHint(),
    "{{IDENTITY_DOMAIN}}": domain || "work",
    "{{MARKETPLACE}}": b.marketplace,
    "{{MARKETPLACE_NAME}}": b.marketplaceName,
    "{{ALLOWED_SENDERS}}": domain ? `*@${domain}` : "*",
    "{{PLIST_ID}}": `com.${b.orgName.toLowerCase().replace(/[^a-z0-9]/g, "")}.bab-listener`,
    "{{PLATFORM_LABELS}}": platformLabels().join(", "),
    "{{TEAM_TAGS}}": teamTags().map((t) => `\`${t}\``).join(", "),
    "{{FILES_LIMITS}}": filesLimits(),
  };
  return text.replace(PLACEHOLDER_RE, (m, name?: string) => {
    if (name === "ORIGIN" || m === "<origin>" || m === "__BAB_ORIGIN__") return origin ?? (m.startsWith("{{") ? m : "{{ORIGIN}}");
    return values[m] ?? m;
  });
}

/** Bytes as whole GB when they are a whole number of them, else MB (one decimal when needed). */
export function sizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024 && Number.isInteger(mb / 1024)) return `${mb / 1024} GB`;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/** The file store's limits on this deployment, for the served skill (config().files). */
function filesLimits(): string {
  const f = config().files;
  return `${sizeText(f.maxFileBytes)} per file, ${sizeText(f.userQuotaBytes)} per person, kept ${f.defaultExpiryDays} days by default, at most ${f.maxExpiryDays}`;
}

export interface Instructions {
  version: string;
  install: string;
  skill: string;
}

/**
 * Returns the two instruction documents rendered for this deployment. `version` is the first 12
 * hex chars of sha256 over the rendered text with the origin left unsubstituted, so it changes
 * with the content or the configuration but not with the host that asked.
 */
export function getInstructions(origin: string): Instructions {
  const version = createHash("sha256")
    .update(renderInstructionText(rawInstall, null))
    .update(renderInstructionText(rawSkill, null))
    .digest("hex")
    .slice(0, 12);
  return {
    version,
    install: renderInstructionText(rawInstall, origin),
    skill: renderInstructionText(rawSkill, origin),
  };
}
