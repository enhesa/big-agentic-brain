import { config } from "./config";

/** The configured team slugs (BAB_TEAM_TAGS), in the order given. Validated at startup. */
export function teamTags(): readonly string[] {
  return config().teamTags;
}

/** True when `tag` (any case) is a configured team. */
export function isTeamTag(tag: string): boolean {
  return teamTags().includes(tag.toLowerCase());
}

const ACRONYMS = new Set(["hr", "it"]);

/** A slug as people read it: "expert-services" is "Expert services", "hr" is "HR". */
export function teamLabel(slug: string): string {
  if (ACRONYMS.has(slug)) return slug.toUpperCase();
  const words = slug.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
