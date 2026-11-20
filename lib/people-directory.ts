import { areasByUser } from "./area-contacts";
import { isMaintainer } from "./feedback";
import { learningCountsByAuthor, listUsers, publicUser } from "./users";
import type { PublicUser } from "./types";

/** What everyone sees of a colleague: enough to find them, message them and know what to ask them. */
export interface DirectoryEntry {
  id: string;
  email: string | null;
  name: string | null;
  homeTeam: string | null;
  areas: string[];
}

/** A maintainer also sees roles, when someone joined and was last seen, trust and how many memories they posted. */
export type MaintainerDirectoryEntry = PublicUser & { homeTeam: string | null; areas: string[]; learningCount: number };

/**
 * The people directory for GET /api/people and bab_people. Activity and standing (last seen,
 * created, roles, trust, memory counts) are for maintainers only, like the Users list on /usage.
 * Everyone else gets id, email, name, home team and areas: what bab_send, bab_files and area
 * contacts need.
 */
export function peopleDirectory(viewerId: string): DirectoryEntry[] | MaintainerDirectoryEntry[] {
  const areas = areasByUser();
  const areasOf = (id: string) => (areas.get(id) ?? []).map((a) => a.area);
  if (isMaintainer(viewerId)) {
    const counts = learningCountsByAuthor();
    return listUsers().map((u) => ({ ...publicUser(u), learningCount: counts[u.id] ?? 0, homeTeam: u.home_team, areas: areasOf(u.id) }));
  }
  return listUsers().map((u) => ({ id: u.id, email: u.email, name: u.name, homeTeam: u.home_team, areas: areasOf(u.id) }));
}
