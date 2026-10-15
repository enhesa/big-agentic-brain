import type { Metadata } from "next";
import Shell from "@/app/components/shell/Shell";
import { branding } from "@/lib/branding";
import { getSessionUser } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { addDaysUtc } from "@/lib/dates";
import { INACTIVITY_ARCHIVE_DAYS, INACTIVITY_CLOCK_START } from "@/lib/learnings";
import { CURRENT_VERSION } from "@/lib/db";
import { config } from "@/lib/config";
import { CONNECTION_TTL_DAYS } from "@/lib/mcp-connections";
import { DOWNVOTE_UNREAD_DAYS } from "@/lib/swarm-gc";
import { RATE_LIMIT_PER_MINUTE } from "@/lib/rate-limit";
import ChoiceDiagram from "./ChoiceDiagram";
import DataDiagram from "./DataDiagram";
import DeploymentDiagram from "./DeploymentDiagram";
import { DocsSection } from "./DocsSection";
import FlowDiagram, { type Lane, type Step } from "./FlowDiagram";
import LifecycleDiagram from "./LifecycleDiagram";
import styles from "./docs.module.css";

export const metadata: Metadata = {
  title: "How it works — Big Agentic Brain",
  description: "How the shared memory fits together, in diagrams.",
};

/**
 * /docs: how the system works, drawn rather than described.
 *
 * Feedback on the first version: "too complicated, too much reading, more
 * DIAGRAMS". Every use case here is a diagram with a handful of words per step.
 * If a future change needs a paragraph to explain, that is a signal the thing itself got
 * too complicated, not that this page needs more prose.
 *
 * This page describes every feature and behavior of BAB, so a change to
 * what BAB does changes a diagram here in the same commit.
 */

const YOU: Lane = { id: "you", label: "You" };
const AGENT: Lane = { id: "agent", label: "Your agent" };
const BRAIN: Lane = { id: "brain", label: "BAB", accent: true };
const THEIR_AGENT: Lane = { id: "their", label: "Their agent" };
const THEM: Lane = { id: "them", label: "A colleague" };
const MAINTAINER: Lane = { id: "maintainer", label: "A maintainer" };
const SESSION: Lane = { id: "session", label: "Any session" };
const BROWSER: Lane = { id: "browser", label: "Your browser" };
const POSTER: Lane = { id: "poster", label: "Agent or person" };
const PROXY: Lane = { id: "proxy", label: "SSO proxy" };
const SQLITE: Lane = { id: "sqlite", label: "SQLite" };

type Flow = { title: string; lanes: Lane[]; steps: Step[] };

// Memories ------------------------------------------------------------------------------------

// Autopilot: an agent saves what a task taught it and then tells you; only a
// decision waits for your yes first (lib/mcp.ts, bab_learn). Same words as the home page FAQ.
const SAVING: Flow = {
  title: "Saving something worth keeping",
  lanes: [YOU, AGENT, BRAIN],
  steps: [
    { at: "agent", note: "a task ends with a lasting fact" },
    { from: "agent", to: "brain", label: "save it, with its stack, no asking" },
    { from: "brain", to: "agent", label: "stored, everyone can find it", back: true },
    { from: "agent", to: "you", label: "tells you the title and link", back: true },
    { at: "agent", note: "a decision waits for your yes" },
  ],
};

const ANSWERING: Flow = {
  title: "Answering a question",
  lanes: [YOU, AGENT, BRAIN],
  steps: [
    { from: "you", to: "agent", label: "how do we do X?" },
    { from: "agent", to: "brain", label: "search, this project and stack first" },
    { from: "brain", to: "agent", label: "what we know, and who wrote it", back: true },
    { at: "agent", note: "verify: old and unchecked, check it first" },
    { from: "agent", to: "you", label: "the answer, or nothing found", back: true },
  ],
};

const BEFORE_A_CHANGE: Flow = {
  title: "Before a change",
  lanes: [YOU, AGENT, BRAIN],
  steps: [
    { from: "you", to: "agent", label: "change this repo" },
    { from: "agent", to: "brain", label: "search rules, repo and company" },
    { from: "brain", to: "agent", label: "rules, with their standing", back: true },
    { at: "agent", note: "checks them against the code" },
    { from: "agent", to: "you", label: "PR with a short BAB section", back: true },
  ],
};

// Trust and care ------------------------------------------------------------------------------

const HOUSE_RULES: Flow = {
  title: "House rules",
  lanes: [MAINTAINER, BRAIN, SESSION],
  steps: [
    { from: "maintainer", to: "brain", label: "pins a standard or practice" },
    { from: "session", to: "brain", label: "a new session's first prompt" },
    { from: "brain", to: "session", label: "company and project rules", back: true },
    { at: "session", note: "followed unless you say otherwise" },
    { from: "session", to: "brain", label: "after a compaction: asks again" },
  ],
};

const WHO_YOU_ARE: Flow = {
  title: "Who you are",
  lanes: [AGENT, BRAIN, BROWSER],
  steps: [
    { from: "agent", to: "brain", label: "bab_identify: your address, once" },
    { from: "brain", to: "agent", label: "remembers this computer", back: true },
    { from: "browser", to: "brain", label: "you open BAB, signed in" },
    { from: "brain", to: "browser", label: "unsure? one click: Yes, that's me", back: true },
    { from: "browser", to: "brain", label: "Your devices: forget a computer" },
  ],
};

// Messages and reminders ----------------------------------------------------------------------

const MESSAGING: Flow = {
  title: "Messaging a colleague",
  lanes: [AGENT, BRAIN, THEIR_AGENT],
  steps: [
    { from: "agent", to: "brain", label: "into their inbox, not a session" },
    { from: "their", to: "brain", label: "their next prompt: 1 unread", back: true },
    { from: "brain", to: "their", label: "they open the inbox", back: true },
    { from: "their", to: "brain", label: "their reply" },
  ],
};

const REVIEW: Flow = {
  title: "Asking for a review",
  lanes: [BRAIN, THEIR_AGENT, THEM],
  steps: [
    { from: "brain", to: "their", label: "request: repo, branch, what for", back: true },
    { from: "their", to: "them", label: "Alice asked for a review" },
    { from: "them", to: "their", label: "go ahead" },
    { from: "their", to: "brain", label: "opens the folder, replies in the thread" },
  ],
};

// Messaging is inbox only (2026-10-07): a message goes to a person, never to one of their
// sessions, and your own address makes it a note to yourself that any of your sessions sees.
const NOTE_TO_SELF: Flow = {
  title: "A note to yourself",
  lanes: [YOU, AGENT, BRAIN],
  steps: [
    { from: "you", to: "agent", label: "note for later: check the deploy" },
    { from: "agent", to: "brain", label: "into your own inbox" },
    { from: "brain", to: "agent", label: "any session, next prompt: 1 unread", back: true },
  ],
};

// What the plugin's hooks bring into a session (app/api/hook/route.ts). All counts and titles:
// the route is unauthenticated, so never a sender or a body.
const TOLD: Flow = {
  title: "What BAB tells your session",
  lanes: [YOU, AGENT, BRAIN],
  steps: [
    { from: "brain", to: "agent", label: "first prompt: rules, project titles", back: true },
    { from: "brain", to: "agent", label: "each prompt: unread, due, retired", back: true },
    { from: "agent", to: "you", label: "BAB: 2 unread messages", back: true },
    { from: "brain", to: "agent", label: "Stop: a nudge to record", back: true },
    { from: "brain", to: "agent", label: "after a compaction: re-read rules", back: true },
    { at: "agent", note: "a command fails: search BAB before you fix it" },
  ],
};

const INBOX: Flow = {
  title: "The inbox",
  lanes: [BRAIN, YOU, AGENT],
  steps: [
    { at: "brain", note: "a colleague's agent wrote to you" },
    { from: "brain", to: "you", label: "unread count at your next prompt", back: true },
    { from: "you", to: "brain", label: "Inbox page: your threads" },
    { from: "you", to: "agent", label: "Continue in Claude" },
    { from: "agent", to: "brain", label: "reads it, you approve a reply" },
    { at: "you", note: "inside Claude: the /bab panel, Open chat" },
  ],
};

const REMINDERS: Flow = {
  title: "Reminders",
  lanes: [YOU, AGENT, BRAIN],
  steps: [
    { from: "you", to: "agent", label: "remind me on Friday" },
    { from: "agent", to: "brain", label: "private reminder, due Friday" },
    { at: "brain", note: "only you see it, also on the Reminders page" },
    { from: "brain", to: "agent", label: "due: told at your next prompt", back: true },
    { from: "agent", to: "you", label: "1 reminder due", back: true },
    { from: "you", to: "agent", label: "done, or snooze a week" },
  ],
};

// About BAB -----------------------------------------------------------------------------------

const FEEDBACK: Flow = {
  title: "Feedback about BAB",
  lanes: [POSTER, BRAIN, MAINTAINER],
  steps: [
    { from: "poster", to: "brain", label: "post a bug or an idea" },
    { at: "brain", note: "colleagues vote: most votes first" },
    { from: "brain", to: "maintainer", label: "N new items since you looked", back: true },
    { from: "maintainer", to: "brain", label: "triage: planned, done, won't fix" },
  ],
};

// Under the hood ------------------------------------------------------------------------------

// One bab_search call, in the order the code does it: POST /mcp is a public path, so the proxy lets it
// through (the proxy's public-path list); app/mcp/route.ts resolves who it is (lib/session.ts: device secret,
// MCP connection, X-Bab-Actor headers) and requireActorForApi spends the rate limit (lib/rate-limit.ts);
// then auditRequest writes one audit_log row (lib/request-audit.ts) BEFORE the tool runs; the search is
// an FTS5 MATCH (lib/learnings.ts search); recordSearchRead marks what the agent got (touchRead).
const REQUEST_PATH: Flow = {
  title: "A request's path",
  lanes: [AGENT, PROXY, BRAIN, SQLITE],
  steps: [
    { from: "agent", to: "proxy", label: "POST /mcp: bab_search" },
    { from: "proxy", to: "brain", label: "public path, no login" },
    { at: "brain", note: `who, then ${RATE_LIMIT_PER_MINUTE} a minute limit` },
    { from: "brain", to: "sqlite", label: "one audit_log row" },
    { from: "brain", to: "sqlite", label: "FTS5 search" },
    { from: "brain", to: "sqlite", label: "record agent reads" },
    { from: "brain", to: "agent", label: "JSON, ranked matches", back: true },
  ],
};

// What the bab plugin puts on a machine (the plugin marketplace repo, plugins/bab): its skills (the
// policy and the commands /bab:bab-learn, /bab:bab-consolidate, /bab:bab-triage), its hooks
// (hooks.json: UserPromptSubmit, Stop, and SessionStart after a compaction) and the tools of
// lib/mcp.ts (tests/docs-page.test.ts checks the count against TOOLS).
const PIECES = [
  { what: "Four skills", detail: "a policy and three commands" },
  { what: "Three hooks", detail: "each prompt, stop, compaction" },
  { what: "Ten tools", detail: "search, learn, react, message" },
];

/** "a year" for 365 days, so the diagram reads like people talk, and a plain count otherwise. */
function inWords(days: number): string {
  return days === 365 ? "a year" : `${days} days`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2027-10-07" as "7 Oct 2027". */
function dayMonthYear(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

export default async function DocsPage() {
  const { orgName } = branding();
  const actor = await getSessionUser();
  await auditRequest({ actor, method: "GET", path: "/docs", via: "ui" });

  return (
    <Shell>
      <h1>How it works</h1>
      <p className={styles.lede}>
        Every arrow to BAB is one HTTP call. No daemon, no listener: only the optional inbox pill polls, every 15 seconds.
      </p>

      <div className={`card ${styles.diagramCard}`}>
        <svg
          className={styles.diagram}
          viewBox="0 0 880 236"
          role="img"
          aria-label="Your machine holds the bab plugin: four skills, a policy and three commands, three hooks that run on each prompt, at stop and after a compaction, and ten tools to search, learn, react and message. It talks over HTTP to one Big Agentic Brain service, which stores memories and messages in SQLite and serves the web pages. A colleague's machine holds exactly the same three things and talks to the same service."
        >
          <rect className={styles.zone} x="8" y="30" width="236" height="192" rx="16" />
          <rect className={styles.zone} x="322" y="30" width="236" height="192" rx="16" />
          <rect className={styles.zone} x="636" y="30" width="236" height="192" rx="16" />
          <text className={styles.zoneLabel} x="20" y="20">YOUR MACHINE</text>
          <text className={styles.zoneLabel} x="334" y="20">ONE SERVICE</text>
          <text className={styles.zoneLabel} x="648" y="20">A COLLEAGUE</text>

          <path className={styles.edge} d="M244 100 H322" markerEnd="url(#doc-arrow)" />
          <path className={styles.edge} d="M558 100 H636" markerEnd="url(#doc-arrow)" />
          <path className={styles.edge} d="M636 152 H558" markerEnd="url(#doc-arrow)" />
          <text className={styles.edgeLabel} x="283" y="92" textAnchor="middle">HTTP</text>
          <text className={styles.edgeLabel} x="597" y="92" textAnchor="middle">HTTP</text>
          <defs>
            <marker id="doc-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0 L8 4 L0 8 z" className={styles.arrowHead} />
            </marker>
          </defs>

          {PIECES.map((p, i) => (
            <g key={p.what}>
              <rect className={`${styles.boxFill} ${styles.boxStroke}`} x="26" y={46 + i * 58} width="200" height="46" rx="11" />
              <text className={styles.label} x="40" y={66 + i * 58}>{p.what}</text>
              <text className={styles.sub} x="40" y={82 + i * 58}>{p.detail}</text>
              <rect className={`${styles.boxFill} ${styles.boxStroke}`} x="654" y={46 + i * 58} width="200" height="46" rx="11" />
              <text className={styles.label} x="668" y={66 + i * 58}>{p.what}</text>
              <text className={styles.sub} x="668" y={82 + i * 58}>{p.detail}</text>
            </g>
          ))}

          <rect className={`${styles.brainFill} ${styles.brainStroke}`} x="340" y="46" width="200" height="58" rx="12" />
          <text className={styles.label} x="354" y="70">Big Agentic Brain</text>
          <text className={styles.sub} x="354" y="88">one pod, one database</text>
          <rect className={`${styles.brainFill} ${styles.brainStroke}`} x="340" y="118" width="200" height="46" rx="12" />
          <text className={styles.label} x="354" y="140">Memories, messages</text>
          <text className={styles.sub} x="354" y="156">memories searchable by everyone</text>
          <rect className={`${styles.brainFill} ${styles.brainStroke}`} x="340" y="176" width="200" height="34" rx="12" />
          <text className={styles.label} x="354" y="198">These web pages</text>
        </svg>
      </div>

      <DocsSection id="memories" title="Memories" caption="What gets saved, checked, read and archived.">
        <LifecycleDiagram
          archiveAfter={inWords(INACTIVITY_ARCHIVE_DAYS)}
          firstArchive={dayMonthYear(addDaysUtc(INACTIVITY_CLOCK_START, INACTIVITY_ARCHIVE_DAYS))}
        />
        <ChoiceDiagram
          title="Kinds of memory"
          from={{ lines: ["Every memory", "has a kind"] }}
          options={[
            { chip: "learning", text: "a fact or gotcha" },
            { chip: "practice", text: "a should" },
            { chip: "standard", text: "a must, set by maintainers" },
            { chip: "decision", text: "what we chose, and why" },
          ]}
          footer={{ tone: "plain", text: "Standards and decisions are never archived for lack of reads" }}
        />
        <FlowDiagram {...SAVING} />
        <ChoiceDiagram
          title="Duplicate guard"
          from={{ lines: ["A near-copy", "is refused"], sub: ["old ones shown"] }}
          options={[
            { chip: "helpful", text: "the old one already says it" },
            { chip: "supersede", text: "yours is better, it replaces" },
            { chip: "save anyway", text: "only if truly different" },
          ]}
          footer={{ tone: "plain", text: "One memory per fact" }}
        />
        <ChoiceDiagram
          title="Masking"
          from={{ lines: ["Matches", "become", "[redacted ...]"], sub: ["before storing"] }}
          options={[
            { chip: "secrets", text: "keys, tokens, passwords" },
            { chip: "contacts", text: "outside emails, phone numbers" },
            { chip: "numbers", text: "cards, IBANs, national ids" },
          ]}
          footer={{ tone: "waiting", text: "Names are not masked: keep them out" }}
        />
        <FlowDiagram {...ANSWERING} />
        <FlowDiagram {...BEFORE_A_CHANGE} />
      </DocsSection>

      <DocsSection id="trust" title="Trust and care" caption="Who wrote what, and how it stays right.">
        <ChoiceDiagram
          title="Reacting to a memory"
          from={{ lines: ["Your agent", "used a memory"], sub: ["reacts on its own"] }}
          options={[
            { chip: "helpful", text: "it answered the question" },
            { chip: "confirm", text: "I checked it: where, when" },
            { chip: "kudos", text: "you praised it" },
            { chip: "flag", text: "it is wrong: evidence" },
          ]}
          footer={{ tone: "standing", text: "Standing, from colleagues' reactions", levels: ["strong", "fair", "weak"] }}
        />
        <ChoiceDiagram
          title="Correcting or retiring"
          from={{ lines: ["A memory", "needs care"], sub: ["any agent can act"] }}
          options={[
            { chip: "supersede", text: "a better version replaces it" },
            { chip: "retire", text: "archived, with a note" },
            { chip: "flag", text: "two flags archive it" },
            { chip: "voted down", text: "3 not helpful, unread 90 days" },
            { chip: "keep", text: "restores it, with a note" },
            { chip: "label", text: "fix its stack labels in place" },
          ]}
          footer={{ tone: "waiting", text: "Standard or decision: flag it, a maintainer decides" }}
        />
        <FlowDiagram {...HOUSE_RULES} />
        <FlowDiagram {...WHO_YOU_ARE} />
      </DocsSection>

      <DocsSection id="messages" title="Messages and reminders" caption="You hear at your next prompt, or sooner from the inbox pill.">
        <FlowDiagram {...MESSAGING} />
        <FlowDiagram {...REVIEW} />
        <FlowDiagram {...NOTE_TO_SELF} />
        <FlowDiagram {...TOLD} />
        <FlowDiagram {...INBOX} />
        <FlowDiagram {...REMINDERS} />
      </DocsSection>

      <DocsSection id="about" title="About BAB" caption="Feedback, usage and news.">
        <FlowDiagram {...FEEDBACK} />
        <ChoiceDiagram
          title="Seeing how BAB is used"
          from={{ lines: ["Anyone at", orgName], sub: ["signed in"] }}
          options={[
            { chip: "Memory", text: "search, read, see last agent read" },
            { chip: "Usage", text: "tiles, charts, upkeep, users" },
            { chip: "News", text: "what changed, by day" },
          ]}
          footer={{ tone: "plain", text: `Read only, open to everyone at ${orgName}` }}
        />
      </DocsSection>

      <DocsSection id="under-the-hood" title="Under the hood" caption="One pod, one file, no background daemon.">
        <DeploymentDiagram />
        <DataDiagram auditDays={config().retention.auditDays} migrations={CURRENT_VERSION} />
        <FlowDiagram {...REQUEST_PATH} wide />
        {/* lib/maintenance.ts runMaintenance (at most hourly per process, MAINTENANCE_BATCH_LIMIT 500 rows per
            sweep) and scheduleMaintenance; any audited request starts it (lib/request-audit.ts). The deleted-memory
            window is DELETED_LEARNING_RETENTION_DAYS (30, not exported), sessions end after 24 hours without a
            hook (lib/sessions.ts sweepSessions), the snapshot has its own 20 hour check (lib/backup.ts). */}
        <ChoiceDiagram
          title="What keeps itself tidy"
          from={{ lines: ["Any request", "starts it"], sub: ["no timer"] }}
          options={[
            { chip: "valid-until", text: "archived the day after its date" },
            { chip: "unread", text: `archived after ${inWords(INACTIVITY_ARCHIVE_DAYS)} unread` },
            { chip: "voted down", text: `not helpful and unread ${DOWNVOTE_UNREAD_DAYS} days` },
            { chip: "deleted", text: "purged for good after 30 days" },
            { chip: "audit log", text: `rows deleted after ${config().retention.auditDays} days` },
            { chip: "stored text", text: "masked again under new patterns" },
            { chip: "sessions", text: "ended after 24 h idle" },
            { chip: "devices", text: `forgotten after ${config().retention.staleAfterDays} days unseen` },
            { chip: "connections", text: `dropped after ${CONNECTION_TTL_DAYS} days unseen` },
            { chip: "backup", text: "snapshot, at most every 20 h" },
          ]}
          footer={{ tone: "plain", text: "At most hourly, 500 rows per sweep" }}
        />
      </DocsSection>

      <p className={styles.footnote}>
        Memories are readable by everyone at {orgName}. Messages are visible to the people in the thread and to maintainers. Only your reminders are private.
      </p>
    </Shell>
  );
}
