import Link from "next/link";
import { branding } from "@/lib/branding";
import Shell from "@/app/components/shell/Shell";
import { getViewer } from "@/lib/notify-auth";
import { auditRequest } from "@/lib/request-audit";
import { isMaintainer } from "@/lib/feedback";
import { parseDbTime } from "@/lib/dates";
import { getUsersByIds, learningCountsByAuthor, listUsersPage } from "@/lib/users";
import { GENERAL_PROJECT_KEY } from "@/lib/project-key";
import {
  IDENTIFY_LOOP_THRESHOLD,
  MONTH_DAYS,
  QUIET_DAYS,
  NUDGE_FOLLOW_MINUTES,
  STANDING_SAMPLE_MAX,
  TEAM_TAGS,
  USAGE_COLLECTING_SINCE,
  cachedUsageReport,
  weekStart,
} from "@/lib/usage";
import { AreaLine, GroupedBars, HBars, MiniBars, Sparkline, StackedBar, formatCount, type BarRow, type MiniBarRow } from "./charts";
import styles from "./usage.module.css";

/**
 * /usage: how the organization uses BAB, as charts and numbers (docs/spec.md "Usage page"). Read-only and open
 * to everyone who can open the site, like /memory (an anonymous viewer is treated as a
 * non-maintainer). Plain words for everyone; tool names only in the Health card. Anything that
 * names a person or a device next to a problem (identify loop rows, flag authors) is for
 * maintainers only. The Users directory (name, email, last seen) is the exception on purpose: it was
 * the open /people page before it became a section here (owner, 2026-10-07), so it stays open to
 * everyone who can open the site.
 *
 * Honest about missing data: weeks before the first activity collapse into one note, numbers that
 * only exist since USAGE_COLLECTING_SINCE say so, and an empty chart is a short note, not zeros.
 */

/** "6 Oct" for a Monday given as YYYY-MM-DD. */
function dayMonth(day: string | Date): string {
  const d = typeof day === "string" ? new Date(`${day}T00:00:00Z`) : day;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

function pct(part: number, whole: number): string | null {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : null;
}

const KIND_LABELS: Record<string, string> = {
  learning: "Learnings",
  practice: "Practices",
  standard: "Standards",
  decision: "Decisions",
};

/** "claude-opus-5-5" to "Opus 5.5"; any other model id is shown as it is. */
function modelLabel(id: string): string | null {
  const m = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(id);
  return m ? `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2].replace(/-/g, ".")}` : null;
}

function teamLabel(tag: string): string {
  return tag === "hr" || tag === "it" ? tag.toUpperCase() : tag.charAt(0).toUpperCase() + tag.slice(1);
}

function Delta({ now, before }: { now: number; before: number }) {
  const d = now - before;
  const title = `This week so far: ${formatCount(now)}. Last week by this time: ${formatCount(before)}.`;
  if (d === 0) {
    return (
      <span className={`${styles.delta} ${styles.deltaFlat}`} title={title}>
        Same as last week
      </span>
    );
  }
  return (
    <span className={`${styles.delta} ${d > 0 ? styles.deltaUp : styles.deltaDown}`} title={title}>
      <span aria-hidden="true">{d > 0 ? "▲" : "▼"}</span> {`${d > 0 ? "+" : "−"}${formatCount(Math.abs(d))}`}{" "}
      <span className={styles.deltaWhat}>vs last week</span>
    </span>
  );
}

function HeroTile({
  label,
  value,
  before,
  spark,
  testId,
  title,
}: {
  label: string;
  value: number;
  before: number;
  spark: { values: number[]; label: string };
  testId: string;
  title: string;
}) {
  return (
    <div className={styles.hero} title={title}>
      <span className={styles.heroLabel}>{label}</span>
      <div className={styles.heroRow}>
        <span className={styles.heroValue} data-testid={testId}>
          {formatCount(value)}
        </span>
        <Sparkline values={spark.values} label={spark.label} />
      </div>
      <Delta now={value} before={before} />
    </div>
  );
}

function Card({
  title,
  sub,
  span,
  id,
  children,
}: {
  title: string;
  sub?: React.ReactNode;
  span: "s4" | "s5" | "s6" | "s7" | "s12";
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`${styles.card} ${styles[span]}`} aria-label={title}>
      <header className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{title}</h3>
        {sub && <div className={styles.cardSub}>{sub}</div>}
      </header>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

function Since() {
  return <span className={styles.since}>since {dayMonth(USAGE_COLLECTING_SINCE)}</span>;
}

function MiniTile({
  label,
  value,
  title,
  href,
  tone,
  testId,
  foot,
}: {
  label: string;
  value: React.ReactNode;
  title: string;
  href?: string;
  tone?: "warn";
  testId?: string;
  foot?: React.ReactNode;
}) {
  const cls = `${styles.mini} ${tone === "warn" ? styles.miniWarn : ""}`;
  const body = (
    <>
      <span className={styles.miniValue} data-testid={testId}>
        {value}
      </span>
      <span className={styles.miniLabel}>
        {tone === "warn" && (
          <span className={styles.warnIcon} aria-hidden="true">
            !
          </span>
        )}
        {label}
      </span>
      {foot && <span className={styles.miniFoot}>{foot}</span>}
    </>
  );
  return href ? (
    <a href={href} className={cls} title={title}>
      {body}
    </a>
  ) : (
    <div className={cls} title={title}>
      {body}
    </div>
  );
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams?: Promise<{ users?: string }>;
} = {}) {
  const viewer = await getViewer();
  await auditRequest({
    actor: viewer?.actor ?? null,
    method: "GET",
    path: "/usage",
    via: "ui",
    // One row per viewer per few minutes is enough; reloads would otherwise write one each.
    coalesce: { minutes: 5 },
  });
  const maintainer = viewer !== null && isMaintainer(viewer.ownerId);
  const usersPage = listUsersPage(Number((await searchParams)?.users));
  const memoryCounts = learningCountsByAuthor();

  const report = cachedUsageReport();
  const generated = new Date(report.generatedAt);
  const { activity, capture, identify, quality, growth, contents, upkeep } = report;
  const n = report.weeks.length;
  const current = activity[n - 1];
  const before = report.lastWeekToDate;

  // Weeks before the first audit row, or before the first recorded activity, have no data at
  // all: they collapse into one note instead of a run of zeros. A page view alone (people) does
  // not count as activity, so a fresh install still shows only its current week.
  const auditWeek = report.dataSince ? weekStart(parseDbTime(report.dataSince)) : null;
  const activeWeek =
    report.weeks.find(
      (_, i) =>
        activity[i].saves +
          activity[i].searches +
          activity[i].reactions +
          capture[i].learnCalls +
          identify[i].identifies +
          identify[i].refused +
          quality[i].duplicateRejected >
        0,
    ) ?? report.weeks[n - 1];
  const firstWeek = auditWeek === null ? report.weeks[n - 1] : auditWeek > activeWeek ? auditWeek : activeWeek;
  const shown = activity.filter((w) => w.week >= firstWeek);
  const hiddenWeeks = n - shown.length;
  const weekOf = (week: string) => `Week of ${dayMonth(week)}`;
  const sparkOf = (key: "saves" | "searches" | "reactions" | "people", what: string) => ({
    values: shown.map((w) => w[key]),
    label: `${what} per week: ${shown.map((w) => `${dayMonth(w.week)} ${w[key]}`).join(", ")}`,
  });

  // Health: Stop nudges and refusals only exist from USAGE_COLLECTING_SINCE.
  const collectWeek = weekStart(new Date(`${USAGE_COLLECTING_SINCE}T00:00:00Z`));
  const nudgeWeeks = capture.filter((w) => w.week >= firstWeek && w.week >= collectWeek);
  const nudges = nudgeWeeks.reduce((s, w) => s + w.nudges, 0);
  const followed = nudgeWeeks.reduce((s, w) => s + w.followed, 0);
  const refused = report.refusalsByReason.reduce((s, r) => s + r.n, 0);
  const loops = report.identifyLoops.length;
  const identifies = identify.reduce((s, w) => s + w.identifies, 0);
  const rememberedNone = identify.reduce((s, w) => s + w.none, 0);
  const stored = quality.reduce((s, w) => s + w.created, 0);
  const duplicates = quality.reduce((s, w) => s + w.duplicateRejected, 0);
  const flags = report.flagged.length;

  const activityTotal = shown.reduce((s, w) => s + w.saves + w.searches + w.reactions, 0);

  const kindRows: BarRow[] = contents.byKind.map((k) => ({
    key: k.key,
    label: KIND_LABELS[k.key] ?? k.key,
    n: k.n,
    title: `${KIND_LABELS[k.key] ?? k.key}: ${plural(k.n, "live memory", "live memories")}`,
  }));
  const kindTotal = contents.byKind.reduce((s, k) => s + k.n, 0);
  const teamRows: BarRow[] = [
    ...contents.byTeam.map((t) => ({
      key: t.key,
      label: teamLabel(t.key),
      n: t.n,
      title: `Tagged ${t.key}: ${plural(t.n, "live memory", "live memories")}`,
    })),
    ...(contents.noTeamTag > 0
      ? [{ key: "_none", label: "No team tag", n: contents.noTeamTag, title: `No team tag: ${plural(contents.noTeamTag, "live memory", "live memories")}`, muted: true }]
      : []),
  ];
  const standingTotal = contents.standing.strong + contents.standing.fair + contents.standing.weak;

  const projectRows: BarRow[] = [
    ...report.topProjects.map((p) => ({
      key: p.project,
      label: <Link href={`/memory?project=${encodeURIComponent(p.project)}`}>{p.project}</Link>,
      n: p.n,
      title: `${p.project}: ${plural(p.n, "live memory", "live memories")}`,
    })),
    ...(report.generalCount > 0
      ? [
          {
            key: GENERAL_PROJECT_KEY,
            label: <Link href={`/memory?project=${GENERAL_PROJECT_KEY}`}>General</Link>,
            n: report.generalCount,
            title: `Company-wide, no project: ${plural(report.generalCount, "live memory", "live memories")}`,
            muted: true,
          },
        ]
      : []),
  ];

  const modelRows: BarRow[] = report.models.map((m) => ({
    key: m.key || "_none",
    label: m.key === "" ? "Not stated" : m.key === "other" ? "Other models" : (modelLabel(m.key) ?? <code className={styles.code}>{m.key}</code>),
    n: m.n,
    title: `${m.key === "" ? "No model stated" : m.key}: ${plural(m.n, "memory", "memories")} saved since ${dayMonth(USAGE_COLLECTING_SINCE)}`,
    muted: m.key === "",
  }));

  const modelsTotal = report.models.reduce((sum, m) => sum + m.n, 0);
  const modelsStated = report.models.reduce((sum, m) => sum + (m.key === "" ? 0 : m.n), 0);

  // Authors per team per week, as a heat grid over the weeks with data.
  const teams = report.teams.filter((w) => w.week >= firstWeek);
  const teamsInUse = TEAM_TAGS.filter((t) => teams.some((w) => (w.byTeam[t] ?? 0) > 0));
  const heatRows = [
    ...teamsInUse.map((t) => ({ name: teamLabel(t), tag: t as string, counts: teams.map((w) => w.byTeam[t] ?? 0) })),
    { name: "No team tag", tag: "", counts: teams.map((w) => w.noTeamTag) },
  ];
  const heatMax = Math.max(0, ...heatRows.flatMap((r) => r.counts));

  const helpfulMax = Math.max(1, ...report.topHelpful.map((h) => h.total));

  // Clean-up card (swarm garbage collection): what the votes cleaned, per week, last 8 weeks.
  const cleanup = report.cleanup;
  const cleanupWeeks = cleanup.map((w) => weekOf(w.week));
  const cleanupRows: MiniBarRow[] = [
    { key: "inactive", label: "Archived unread", values: cleanup.map((w) => w.inactive), className: styles.fillMuted, title: "Learnings and practices archived because no agent read them for a year." },
    { key: "downvoted", label: "Archived, not helpful", values: cleanup.map((w) => w.downvoted), className: styles.fill3, title: "Learnings and practices that three or more colleagues marked not helpful, archived after 90 days without an agent read." },
    { key: "flagged", label: "Archived by flags", values: cleanup.map((w) => w.flagged), className: styles.fill3Soft, title: "Memories archived because two people flagged them." },
    { key: "retired", label: "Retired", values: cleanup.map((w) => w.retired), className: styles.fill2, title: "Memories someone retired as out of date." },
    { key: "kept", label: "Restored or kept", values: cleanup.map((w) => w.kept), className: styles.fill1, title: "Memories someone checked and kept, or brought back." },
    { key: "verified", label: "Old memories verified", values: cleanup.map((w) => w.verified), className: styles.ord3, title: "Confirmations on memories over 90 days old that nobody had checked lately." },
  ];
  const cleanupTotal = cleanupRows.reduce((s, r) => s + r.values.reduce((a, b) => a + b, 0), 0);

  const people = maintainer ? getUsersByIds(report.flagged.map((f) => f.authorId)) : new Map();
  const nameOf = (id: string) => people.get(id)?.name ?? id;

  return (
    <Shell>
      <div className={styles.page}>
        <header className={styles.header}>
          <div>
            <span className="kicker">{maintainer ? <Link href="/admin">Admin</Link> : "BAB"}</span>
            <h1 className={styles.h1}>Usage</h1>
            <p className={styles.subline}>How {branding().orgName} uses BAB, week by week.</p>
          </div>
          <div className={styles.headerMeta}>
            <time className={styles.updated} dateTime={report.generatedAt} title="Weeks run Monday to Sunday, UTC. Numbers refresh every 5 minutes.">
              Updated {dayMonth(generated)}, {generated.toISOString().slice(11, 16)} UTC
            </time>
            {hiddenWeeks > 0 && (
              <span className={styles.gapNote} title="Earlier weeks have no recorded activity, so they are left out.">
                No data before {dayMonth(firstWeek)}
              </span>
            )}
          </div>
        </header>

        {/* 1. This week */}
        <section aria-label="This week" className={styles.heroes} data-testid="usage-tiles">
          <HeroTile
            label="Memories saved"
            value={current.saves}
            before={before.saves}
            spark={sparkOf("saves", "Memories saved")}
            testId="tile-saved"
            title="New memories saved this week, Monday to now (UTC)."
          />
          <HeroTile
            label="Searches"
            value={current.searches}
            before={before.searches}
            spark={sparkOf("searches", "Searches")}
            testId="tile-searches"
            title="Searches agents ran in BAB this week."
          />
          <HeroTile
            label="Found it helpful"
            value={current.reactions}
            before={before.reactions}
            spark={sparkOf("reactions", "Helpful reactions")}
            testId="tile-helpful"
            title="Helpful, kudos and confirm reactions on memories this week."
          />
          <HeroTile
            label="People using BAB"
            value={current.people}
            before={before.people}
            spark={sparkOf("people", "People using BAB")}
            testId="tile-people"
            title="Everyone whose agent or browser used BAB this week."
          />
        </section>

        {/* 2 and 3. Growth and activity */}
        <div className={styles.grid}>
          <Card
            title="Memories in BAB"
            span="s6"
            sub={
              <>
                <strong className={styles.bigInline} data-testid="growth-live">
                  {formatCount(growth.live)}
                </strong>{" "}
                {growth.lastMonth > 0 && (
                  <span className={styles.chip} title={`Live memories saved in the last ${MONTH_DAYS} days`} data-testid="growth-month">
                    +{formatCount(growth.lastMonth)} this month
                  </span>
                )}
              </>
            }
          >
            {growth.points.length < 2 ? (
              <Empty>{growth.live === 0 ? "No memories yet." : "A trend shows from the second week."}</Empty>
            ) : (
              <AreaLine
                label={`Live memories by the week they were saved, ${dayMonth(growth.points[0].week)} to now: ${formatCount(growth.live)}`}
                data={growth.points.map((p) => ({
                  label: dayMonth(p.week),
                  value: p.total,
                  title: `${weekOf(p.week)}: ${plural(p.total, "memory", "memories")}`,
                }))}
              />
            )}
          </Card>

          <Card title="Activity per week" span="s6" sub={<Legend3 />}>
            {activityTotal === 0 ? (
              <Empty>No saves, searches or reactions yet.</Empty>
            ) : (
              <>
                <GroupedBars
                  label={`Saves, searches and helpful reactions per week, last ${plural(shown.length, "week")}`}
                  series={[
                    { name: "Saves", className: styles.fill1 },
                    { name: "Searches", className: styles.fill2 },
                    { name: "Found helpful", className: styles.fill3 },
                  ]}
                  data={shown.map((w) => ({
                    label: dayMonth(w.week),
                    values: [w.saves, w.searches, w.reactions],
                    title: `${weekOf(w.week)}: ${plural(w.saves, "save")}, ${plural(w.searches, "search", "searches")}, ${plural(w.reactions, "helpful reaction")}`,
                  }))}
                />
                <details className={styles.numbers}>
                  <summary>Numbers</summary>
                  <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Week of</th>
                        <th className={styles.num}>Saves</th>
                        <th className={styles.num}>Searches</th>
                        <th className={styles.num}>Helpful</th>
                        <th className={styles.num}>People</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((w) => (
                        <tr key={w.week}>
                          <td>{dayMonth(w.week)}</td>
                          <td className={styles.num}>{formatCount(w.saves)}</td>
                          <td className={styles.num}>{formatCount(w.searches)}</td>
                          <td className={styles.num}>{formatCount(w.reactions)}</td>
                          <td className={styles.num}>{formatCount(w.people)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </details>
              </>
            )}
          </Card>
        </div>

        {/* 4. What's in BAB */}
        <section className={styles.group} aria-labelledby="contents-h">
          <h2 id="contents-h" className={styles.h2}>
            What&apos;s in BAB
          </h2>
          <div className={styles.grid}>
            <div className={styles.column}>
              <Card title="By kind" span="s12">
                {kindTotal === 0 ? <Empty>No memories yet.</Empty> : <HBars label="Live memories by kind" rows={kindRows} />}
              </Card>
              <Card
                title="Standing"
                span="s12"
                sub={contents.standingRead >= STANDING_SAMPLE_MAX ? `Newest ${formatCount(STANDING_SAMPLE_MAX)}` : "From colleagues' reactions"}
              >
                {standingTotal === 0 ? (
                  <Empty>No memories yet.</Empty>
                ) : (
                  <StackedBar
                    label={`Standing of live memories: ${contents.standing.strong} strong, ${contents.standing.fair} fair, ${contents.standing.weak} weak`}
                    segments={[
                      { key: "strong", name: "Strong", n: contents.standing.strong, className: styles.ord3, swatchClassName: styles.swOrd3 },
                      { key: "fair", name: "Fair", n: contents.standing.fair, className: styles.ord2, swatchClassName: styles.swOrd2 },
                      { key: "weak", name: "Weak", n: contents.standing.weak, className: styles.ord1, swatchClassName: styles.swOrd1 },
                    ]}
                  />
                )}
              </Card>
            </div>
            <Card title="By team" span="s6">
              {teamRows.length === 0 ? <Empty>No memories yet.</Empty> : <HBars label="Live memories by team tag" rows={teamRows} />}
            </Card>
          </div>
        </section>

        {/* 5. Most helpful */}
        <div className={styles.grid}>
          <Card title="Most helpful this month" span="s7" sub={`Last ${MONTH_DAYS} days`}>
            {report.topHelpful.length === 0 ? (
              <Empty>No helpful reactions in the last {MONTH_DAYS} days.</Empty>
            ) : (
              <ol className={styles.top} data-testid="top-helpful">
                {report.topHelpful.map((h, i) => (
                  <li
                    key={h.id}
                    className={styles.topItem}
                    title={`${plural(h.helpful, "helpful")}, ${plural(h.kudos, "kudos", "kudos")}, ${plural(h.confirm, "confirm")}`}
                  >
                    <span className={styles.rank}>{i + 1}</span>
                    <div className={styles.topBody}>
                      <Link href={`/memory/${h.id}`} className={styles.topTitle}>
                        {h.title}
                      </Link>
                      <svg className={styles.hbarTrack} aria-hidden="true">
                        <rect x="0" y="0" width={`${Math.max(1.5, (h.total / helpfulMax) * 100)}%`} height="100%" rx="4" className={styles.fill1} />
                      </svg>
                    </div>
                    <span className={styles.topCount}>{formatCount(h.total)}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <Card title="Top projects" span="s5">
            {projectRows.length === 0 ? <Empty>No memories yet.</Empty> : <HBars label="Live memories by project" rows={projectRows} />}
          </Card>
        </div>

        {/* 6. Who writes */}
        <section className={styles.group} aria-labelledby="writers-h">
          <h2 id="writers-h" className={styles.h2}>
            Who writes
          </h2>
          <div className={styles.grid}>
            <Card
              title="Models"
              span="s5"
              sub={
                modelsTotal === 0 ? (
                  <Since />
                ) : (
                  <>
                    <strong className={styles.bigInline} data-testid="models-stated">
                      {pct(modelsStated, modelsTotal)}
                    </strong>
                    <span className={styles.since} title={`${formatCount(modelsStated)} of ${plural(modelsTotal, "memory", "memories")} saved since ${dayMonth(USAGE_COLLECTING_SINCE)} name the model that wrote them`}>
                      name their model, <Since />
                    </span>
                  </>
                )
              }
            >
              {modelRows.length === 0 ? (
                <Empty>No memories saved since {dayMonth(USAGE_COLLECTING_SINCE)}.</Empty>
              ) : (
                <HBars label={`Memories saved since ${dayMonth(USAGE_COLLECTING_SINCE)}, by model`} rows={modelRows} />
              )}
            </Card>
            <Card title="Authors per team" span="s7" sub="People who saved, per week">
              {heatMax === 0 ? (
                <Empty>No memories saved in these weeks.</Empty>
              ) : (
                <table className={styles.heat} aria-label="Distinct authors per team tag per week">
                  <thead>
                    <tr>
                      <th className={styles.heatTeam}>
                        <span className={styles.srOnly}>Team</span>
                      </th>
                      {teams.map((w) => {
                        const [day, month] = dayMonth(w.week).split(" ");
                        return (
                          <th key={w.week} scope="col" title={weekOf(w.week)}>
                            {day}
                            <span className={styles.heatMonth}> {month}</span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {heatRows.map((r) => (
                      <tr key={r.name}>
                        <th scope="row" className={styles.heatTeam}>
                          {r.name}
                        </th>
                        {r.counts.map((c, i) => {
                          const share = heatMax === 0 || c === 0 ? 0 : 0.18 + 0.82 * (c / heatMax);
                          return (
                            <td
                              key={teams[i].week}
                              className={c === 0 ? styles.heatZero : styles.heatCell}
                              style={
                                c === 0
                                  ? undefined
                                  : {
                                      background: `color-mix(in srgb, var(--u-s1-strong) ${Math.round(share * 100)}%, var(--u-surface))`,
                                      color: share > 0.55 ? "var(--u-on-fill)" : undefined,
                                    }
                              }
                              title={`${r.name}, ${weekOf(teams[i].week).toLowerCase()}: ${plural(c, "author")}`}
                            >
                              {c === 0 ? "·" : c}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </section>

        {/* 7. Upkeep */}
        <section className={styles.group} aria-labelledby="upkeep-h">
          <h2 id="upkeep-h" className={styles.h2}>
            Upkeep <span className={styles.h2Note}>last {MONTH_DAYS} days</span>
          </h2>
          <div className={styles.minis}>
            <MiniTile
              label={`Quiet ${Math.round(QUIET_DAYS / 30)}+ months`}
              value={formatCount(upkeep.quiet)}
              title={`Live memories no agent has read for ${Math.round(QUIET_DAYS / 30)} months or more. They are archived at 12 months unless an agent reads or keeps them.`}
              testId="upkeep-quiet"
            />
            <MiniTile
              label="Archived unread"
              value={formatCount(upkeep.archivedUnread)}
              title="Memories archived because no agent read them for a year. Any agent can restore one with keep."
              testId="upkeep-archived-unread"
            />
            <MiniTile label="Kept" value={formatCount(upkeep.kept)} title="Memories someone checked and kept." testId="upkeep-kept" />
            <MiniTile label="Restored" value={formatCount(upkeep.restored)} title="Retired memories brought back." testId="upkeep-restored" />
            <MiniTile label="Retired" value={formatCount(upkeep.retired)} title="Memories someone retired as out of date." testId="upkeep-retired" />
            <MiniTile
              label="Flags waiting"
              value={formatCount(flags)}
              title="Flagged standards and decisions, and protected memories marked not helpful, waiting for a maintainer."
              href="#health"
              tone={flags > 0 ? "warn" : undefined}
              testId="tile-flags"
            />
          </div>
          <div className={styles.grid}>
            <Card title="Clean-up" span="s7" sub="Last 8 weeks" id="cleanup">
              {cleanupTotal === 0 ? (
                <Empty>No clean-up in these weeks.</Empty>
              ) : (
                <MiniBars label="Memory clean-up per week, last 8 weeks" rows={cleanupRows} weeks={cleanupWeeks} />
              )}
            </Card>
          </div>
        </section>

        {/* 8. Users */}
        <section id="users" className={`${styles.group} ${styles.users}`} aria-labelledby="users-h">
          <h2 id="users-h" className={styles.h2}>
            Users <span className={styles.h2Note}>{plural(usersPage.total, "person", "people")}</span>
          </h2>
          <div className={styles.tableWrap}>
            <table className={styles.table} aria-label="Users">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Last seen</th>
                  <th className={styles.num}>Memories</th>
                </tr>
              </thead>
              <tbody>
                {usersPage.users.length === 0 && (
                  <tr>
                    <td colSpan={4}>No users yet.</td>
                  </tr>
                )}
                {usersPage.users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name ?? u.id}</td>
                    <td className={styles.wide}>{u.email ?? "-"}</td>
                    <td className={styles.nowrap}>{parseDbTime(u.last_seen_at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC</td>
                    <td className={styles.num}>{memoryCounts[u.id] ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {usersPage.pages > 1 && (
            <nav className={styles.pager} aria-label="Users pages" data-testid="users-pager">
              {usersPage.page > 1 ? (
                <Link href={`/usage?users=${usersPage.page - 1}#users`} rel="prev">
                  Previous
                </Link>
              ) : (
                <span aria-disabled="true">Previous</span>
              )}
              <span>
                Page {usersPage.page} of {usersPage.pages}
              </span>
              {usersPage.page < usersPage.pages ? (
                <Link href={`/usage?users=${usersPage.page + 1}#users`} rel="next">
                  Next
                </Link>
              ) : (
                <span aria-disabled="true">Next</span>
              )}
            </nav>
          )}
        </section>

        {/* 9. Health */}
        <section id="health" className={`${styles.card} ${styles.health}`} aria-labelledby="health-h">
          <header className={styles.cardHead}>
            <h2 id="health-h" className={styles.cardTitle}>
              Health
            </h2>
          </header>
          <div className={styles.healthStats}>
            <div
              className={styles.stat}
              title={`A Stop nudge counts as followed when the same person calls bab_learn within ${NUDGE_FOLLOW_MINUTES} minutes.`}
            >
              <span className={styles.statLabel}>
                Stop-nudge conversion <Since />
              </span>
              {nudges === 0 ? (
                <span className={styles.statEmpty}>No nudges yet</span>
              ) : (
                <>
                  <span className={styles.statValue} data-testid="tile-conversion">
                    {pct(followed, nudges)}
                  </span>
                  <span className={styles.statFoot}>
                    {formatCount(followed)} of {plural(nudges, "nudge")}
                  </span>
                </>
              )}
            </div>
            <div
              className={styles.stat}
              title={`A loop is more than ${IDENTIFY_LOOP_THRESHOLD} bab_identify calls from one device or connection in a day. ${formatCount(identifies)} identify calls, ${formatCount(rememberedNone)} remembered none.${report.refusalsByReason.length ? ` Refused: ${report.refusalsByReason.map((r) => `${r.reason} ${r.n}`).join(", ")}.` : ""}`}
            >
              <span className={styles.statLabel}>
                Identify problems <Since />
              </span>
              <span className={styles.statValue} data-testid="tile-identify">
                {formatCount(loops + refused)}
              </span>
              <span className={styles.statFoot}>
                {plural(loops, "loop")}, {formatCount(refused)} refused
              </span>
            </div>
            <div className={styles.stat} title="bab_learn saves the duplicate guard refused (409), in these weeks.">
              <span className={styles.statLabel}>Duplicates caught</span>
              <span className={styles.statValue} data-testid="tile-duplicates">
                {formatCount(duplicates)}
              </span>
              <span className={styles.statFoot}>
                {pct(duplicates, stored + duplicates) ? `${pct(duplicates, stored + duplicates)} of save attempts` : "No saves yet"}
              </span>
            </div>
            <div className={styles.stat} title="Flagged standards and decisions, and protected memories marked not helpful, that only a maintainer can keep, change or retire.">
              <span className={styles.statLabel}>Flags waiting</span>
              <span className={styles.statValue}>{formatCount(flags)}</span>
              <span className={styles.statFoot}>{flags === 0 ? "Nothing to decide" : "For a maintainer"}</span>
            </div>
          </div>

          {flags > 0 &&
            (!maintainer ? (
              <ul className={styles.flagList} data-testid="flags-list">
                {report.flagged.map((f) => (
                  <li key={f.id}>
                    <Link href={`/memory/${f.id}`}>{f.title}</Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Flagged</th>
                      <th>Kind</th>
                      <th>Author</th>
                      <th>Last flagged</th>
                      <th className={styles.num}>Flaggers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.flagged.map((f) => (
                      <tr key={f.id}>
                        <td className={styles.wide}>
                          <Link href={`/memory/${f.id}`}>{f.title}</Link>
                        </td>
                        <td>{f.kind}</td>
                        <td>
                          <Link href={`/memory?author=${encodeURIComponent(f.authorId)}`}>{nameOf(f.authorId)}</Link>
                        </td>
                        <td className={styles.nowrap}>{dayMonth(parseDbTime(f.flaggedAt))}</td>
                        <td className={styles.num}>{f.flaggers}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

          {maintainer && loops > 0 && (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption className={styles.caption}>bab_identify loops, newest first</caption>
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Identified as</th>
                    <th>Grouped by</th>
                    <th className={styles.num}>Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {report.identifyLoops.map((l) => (
                    <tr key={`${l.day}-${l.by}-${l.who}`}>
                      <td className={styles.nowrap}>{l.day}</td>
                      <td className={styles.wide}>
                        {l.who.includes("@") ? <Link href={`/memory?author=${encodeURIComponent(l.who)}`}>{l.who}</Link> : l.who}
                      </td>
                      <td>{l.by}</td>
                      <td className={styles.num}>{l.calls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!maintainer && loops > 0 && (
            <p className={styles.healthNote} data-testid="loops-count">
              Only maintainers see who is looping.
            </p>
          )}
        </section>
      </div>
    </Shell>
  );
}

function Legend3() {
  return (
    <ul className={styles.legend} aria-label="Legend">
      <li>
        <span className={`${styles.swatch} ${styles.sw1}`} /> Saves
      </li>
      <li>
        <span className={`${styles.swatch} ${styles.sw2}`} /> Searches
      </li>
      <li>
        <span className={`${styles.swatch} ${styles.sw3}`} /> Found helpful
      </li>
    </ul>
  );
}

export const dynamic = "force-dynamic";
