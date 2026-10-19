// results.csv / results.json / summary.md for an eval run.
import fs from "node:fs";
import path from "node:path";
import { CONDITIONS } from "./conditions.mjs";
import { mean, median, paired, quantile, wilson } from "./stats.mjs";

export const COND_LABEL = Object.fromEntries(Object.entries(CONDITIONS).map(([k, v]) => [k, v.label]));

export const FIELDS = [
  "run_id", "task", "family", "variant", "condition", "trial", "order_idx", "model", "sandbox", "success", "finished",
  "stop_reason", "wall_s", "turns", "tool_calls", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
  "total_tokens", "cost_usd", "bab_calls_total", "bab_search_calls", "bab_learn_calls", "bab_react_calls", "bab_queried",
  "memory_hit", "memory_hit_rank", "memory_reacted", "zero_result_searches", "injected_relevant", "relevant_seen", "hazard_seen",
  "hazard_flagged", "hazard_endorsed", "suspicious_cmds", "error", "started_at",
];

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function writeCsv(file, rows) {
  fs.writeFileSync(file, [FIELDS.join(","), ...rows.map((r) => FIELDS.map((f) => csvCell(r[f])).join(","))].join("\n") + "\n");
}

const METRICS = [
  ["success", "success rate"],
  ["cost_usd", "cost per run (USD)"],
  ["total_tokens", "tokens per run"],
  ["turns", "LLM turns per run"],
  ["wall_s", "wall-clock per run (s)"],
];

function pct(x) {
  return Number.isFinite(x) ? `${Math.round(x * 100)}%` : "n/a";
}

function fmt(key, v, signed = false) {
  if (!Number.isFinite(v)) return "n/a";
  const s = signed && v >= 0 ? "+" : "";
  if (key === "success") return `${s}${Math.round(v * 100)}%`;
  if (key === "cost_usd") return `${s}${v.toFixed(4)}`;
  return `${s}${v.toFixed(1)}`;
}

/** Summary statistics per condition and paired comparisons; returns { stats, markdown }. */
export function summarize(rows, meta) {
  const allRows = rows;
  const isBad = (r) => r.stop_reason === "error" || r.stop_reason === "timeout" || r.stop_reason === "harness_error";
  const clean = allRows.filter((r) => Number(r.suspicious_cmds) === 0 && !isBad(r));
  const conds = Object.keys(CONDITIONS).filter((c) => clean.some((r) => r.condition === c) || allRows.some((r) => r.condition === c && !isBad(r)));
  const stats = {
    meta, conditions: {}, paired: {},
    flaggedSuspicious: allRows.filter((r) => Number(r.suspicious_cmds) > 0).length,
    erroredOrTimeout: allRows.filter((r) => r.stop_reason === "error" || r.stop_reason === "timeout").length,
    harnessErrors: allRows.filter((r) => r.stop_reason === "harness_error").length,
  };
  const L = [];
  const erroredRows = allRows.filter((r) => r.stop_reason === "error" || r.stop_reason === "timeout");
  const harnessRows = allRows.filter((r) => r.stop_reason === "harness_error");
  const graded = clean;
  const flagged = allRows.filter((r) => Number(r.suspicious_cmds) > 0);
  const cacheRead = clean.reduce((a, r) => a + Number(r.cache_read_tokens || 0), 0);
  const cacheWrite = clean.reduce((a, r) => a + Number(r.cache_write_tokens || 0), 0);
  const inputTok = clean.reduce((a, r) => a + Number(r.input_tokens || 0), 0);
  const successes = clean.filter((r) => Number(r.success) === 1).length;
  const costPerSuccess = successes ? meta.spendUsd / successes : NaN;
  const cacheShare = (cacheRead + inputTok) > 0 ? cacheRead / (cacheRead + inputTok + cacheWrite) : NaN;
  L.push(`# BAB eval summary (${meta.mode})`, "");
  L.push(`Model \`${meta.model}\` (${meta.provider}), BAB ${meta.babCommit}, ${meta.date}. Sandbox: ${meta.sandbox}. Memory for B: ${meta.memory}.`);
  L.push(`Runs: ${allRows.length} (${graded.length} in rates; ${erroredRows.length} errored/timed-out excluded; ${harnessRows.length} harness failures excluded; ${flagged.length} flagged suspicious_cmds>0 excluded).`);
  L.push(`Spend: $${meta.spendUsd.toFixed(4)} (eval) + $${meta.seedCostUsd.toFixed(4)} (seeding)` + (meta.skippedForBudget ? `; ${meta.skippedForBudget} runs skipped for budget` : "") + `.`);
  L.push(`Cost per success: ${Number.isFinite(costPerSuccess) ? "$" + costPerSuccess.toFixed(4) : "n/a"}; cache-read share of prompt tokens: ${Number.isFinite(cacheShare) ? Math.round(cacheShare * 100) + "%" : "n/a"}.`, "");
  if (meta.suite === "tk") {
    L.push("> **Caveat (TK suite):** by construction the repos omit a fictional vendor spec, the prompt names the vendor, the colleague memory is that spec, and the hidden tests check those values. A can only guess. Success deltas measure that the memory channel works, not how often BAB helps on real work.", "");
  }
  L.push("> Paired p-values are **uncorrected** for the number of comparisons. Claims not distinguishable from B at this n are not bolded.", "");
  L.push("| Condition | Runs | Success (95% Wilson CI) | Cost/run mean (median) | Tokens/run median | Turns median [IQR] | Searched BAB | Retrieved relevant (mean rank) | Reacted helpful | Recorded a learning |");
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  const hazardRows = [];
  for (const c of conds) {
    const rs = clean.filter((r) => r.condition === c);
    const k = rs.filter((r) => r.success).length;
    const [p, lo, hi] = wilson(k, rs.length);
    const col = (f) => rs.map((r) => Number(r[f]));
    const ranks = rs.filter((r) => r.memory_hit).map((r) => Number(r.memory_hit_rank));
    const s = {
      runs: rs.length, successes: k, successRate: p, successCi: [lo, hi],
      costMean: mean(col("cost_usd")), costMedian: median(col("cost_usd")), tokensMedian: median(col("total_tokens")),
      turnsMedian: median(col("turns")), turnsIqr: [quantile(col("turns"), 0.25), quantile(col("turns"), 0.75)],
      searchRate: mean(col("bab_queried")), hitRate: mean(col("memory_hit")), meanHitRank: mean(ranks),
      reactedRate: mean(col("memory_reacted")), recordingRate: mean(rs.map((r) => (Number(r.bab_learn_calls) > 0 ? 1 : 0))),
      relevantSeenRate: mean(col("relevant_seen")), hazardSeenRate: mean(col("hazard_seen")), hazardFlaggedRate: mean(col("hazard_flagged")),
    };
    stats.conditions[c] = s;
    const bab = c !== "A";
    const mem = !["A", "C", "ST", "WR"].includes(c);
    if (["ST", "CF", "WR"].includes(c)) hazardRows.push(`| ${COND_LABEL[c]} | ${pct(s.hazardSeenRate)} | ${pct(s.relevantSeenRate)} | ${pct(s.hazardFlaggedRate)} |`);
    L.push(
      `| ${COND_LABEL[c]} | ${s.runs} | ${k}/${s.runs} = ${pct(p)} (${pct(lo)}-${pct(hi)}) | $${s.costMean.toFixed(4)} ($${s.costMedian.toFixed(4)}) | ${Math.round(s.tokensMedian)} | ${s.turnsMedian} [${s.turnsIqr[0]}-${s.turnsIqr[1]}] | ${bab ? pct(s.searchRate) : "n/a"} | ${mem ? `${pct(s.hitRate)} (${Number.isFinite(s.meanHitRank) ? s.meanHitRank.toFixed(1) : "-"})` : "n/a"} | ${mem ? pct(s.reactedRate) : "n/a"} | ${bab ? pct(s.recordingRate) : "n/a"} |`,
    );
  }
  if (hazardRows.length) L.push("", "| Hazard condition | Saw the bad memory | Saw the current memory | Flagged the bad memory |", "|---|---|---|---|", ...hazardRows);
  const comparisons = [];
  for (const c of conds) if (c !== "A" && conds.includes("A")) comparisons.push([c, "A"]);
  if (conds.includes("B") && conds.includes("C")) comparisons.push(["B", "C"]);
  // Ablations and hazards against default BAB with the same memory.
  for (const c of ["L", "F", "N", "R", "AR", "CF"]) if (conds.includes(c) && conds.includes("B")) comparisons.push([c, "B"]);
  if (comparisons.length) {
    L.push("", "## Paired comparisons (unit = task, trials averaged within task)", "");
    L.push("Ratio = mean(X)/mean(baseline). 95% CIs: BCa bootstrap over task clusters (10k) and paired-t; p: exact two-sided sign-flip (uncorrected for multiplicity).", "");
    L.push("| Comparison | Tasks | Metric | Baseline | X | Diff (95% CI) | Ratio (95% CI) | p |", "|---|---|---|---|---|---|---|---|");
  }
  const tasks = [...new Set(clean.map((r) => r.task))].sort();
  for (const [x, base] of comparisons) {
    for (const [subName, sub] of [["all", tasks], ["original", tasks.filter((t) => t.includes("-orig-"))], ["variant", tasks.filter((t) => t.includes("-var-"))]]) {
      if (!sub.length) continue;
      for (const [key, label] of METRICS) {
        const byTask = {};
        for (const t of sub) {
          byTask[t] = {
            A: clean.filter((r) => r.task === t && r.condition === base).map((r) => Number(r[key])),
            X: clean.filter((r) => r.task === t && r.condition === x).map((r) => Number(r[key])),
          };
        }
        const pr = paired(byTask);
        if (!pr.nTasks) continue;
        stats.paired[`${x}-vs-${base}|${subName}|${key}`] = pr;
        const ratio = key === "success" ? "-" : `${pr.ratio.toFixed(2)} (${pr.ratioCi[0].toFixed(2)}-${pr.ratioCi[1].toFixed(2)})`;
        L.push(`| ${x} vs ${base} | ${subName} (${pr.nTasks}) | ${label} | ${fmt(key, pr.aMean)} | ${fmt(key, pr.xMean)} | ${fmt(key, pr.diff, true)} (BCa ${fmt(key, pr.diffCi[0], true)} to ${fmt(key, pr.diffCi[1], true)}; t ${fmt(key, pr.diffCiT[0], true)} to ${fmt(key, pr.diffCiT[1], true)}) | ${ratio} | ${pr.p.toFixed(4)}† |`);
      }
    }
  }
  L.push("", "## Per task (successes/runs; median cost; median turns)", "");
  L.push(`| Task | ${conds.map((c) => COND_LABEL[c]).join(" | ")} |`, `|---|${conds.map(() => "---|").join("")}`);
  for (const t of tasks) {
    const cells = conds.map((c) => {
      const rs = clean.filter((r) => r.task === t && r.condition === c);
      if (!rs.length) return "-";
      return `${rs.filter((r) => r.success).length}/${rs.length}; $${median(rs.map((r) => Number(r.cost_usd))).toFixed(4)}; ${median(rs.map((r) => Number(r.turns)))}t`;
    });
    L.push(`| ${t} | ${cells.join(" | ")} |`);
  }
  if (comparisons.length) L.push("", "† p-values are uncorrected for the number of comparisons. At n≈8 task clusters, differences from B that are not significant at α=0.05 are not claimed.");
  if (tasks.length < 6) L.push("", "_Few tasks: treat CIs and p-values as plumbing checks, not evidence._");
  if (erroredRows.length) {
    L.push("", "## Errored / timed-out runs (excluded from success rates and paired stats)", "");
    for (const r of erroredRows) L.push(`- ${r.run_id}: ${r.stop_reason} ${r.error || ""}`);
  }
  if (harnessRows.length) {
    L.push("", "## Harness failures (no meta.json; excluded from rates; rerun with --resume)", "");
    for (const r of harnessRows) L.push(`- ${r.run_id}: ${r.error || "harness_error"}`);
  }
  if (meta.skippedForBudget) L.push("", `Skipped for budget: ${meta.skippedForBudget} jobs were not started once spend reached the cap.`);
  return { stats, markdown: L.join("\n") + "\n" };
}

export function writeReports(outDir, rows, meta) {
  writeCsv(path.join(outDir, "results.csv"), rows);
  const { stats, markdown } = summarize(rows, meta);
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ ...stats, runs: rows }, (k, v) => (Number.isNaN(v) ? null : v), 2));
  fs.writeFileSync(path.join(outDir, "summary.md"), markdown);
  return markdown;
}
