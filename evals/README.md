# Evals

This directory measures whether BAB actually helps coding agents.

- **Agent eval** (`pnpm eval`) runs a real LLM agent on small bug-fix tasks. It runs once without BAB and once with BAB connected over MCP. In the BAB run, a "colleague" agent has already solved the original or a related bug and recorded what it learned.
- **Retrieval eval** (`pnpm eval:retrieval`) needs no LLM. It loads a fixed memory corpus into a fresh BAB, sends realistic queries through the same MCP `bab_search` an agent uses, and scores recall@k and MRR. It is free and deterministic, so it runs on PRs.
- **Task validation** (`pnpm eval:validate`) needs no LLM. It checks that every task fails as shipped and passes with its reference fix.

There are no extra dependencies. Everything is Node built-ins. The tasks themselves need `python3` and `node` on `PATH`.

## Quick start

```bash
pnpm install && pnpm build          # the evals start throwaway BAB servers from .next/standalone
pnpm eval:validate                  # no LLM
pnpm eval:retrieval                 # no LLM
ANTHROPIC_API_KEY=... pnpm eval     # smoke: Haiku, 3 tasks, A/B, 1 trial, about $0.01-0.05 (cap $0.50)
ANTHROPIC_API_KEY=... pnpm eval:full  # core suite: 12 tasks, A/B/C, 3 trials, live colleague seeding (cap $25)
```

Output goes to `evals/out/<timestamp>-<mode>/`:

| File | Contents |
|---|---|
| `summary.md` | Tables for humans |
| `results.json` | Per-condition stats, paired comparisons and every run |
| `results.csv` | One row per run |
| `meta.json` | Model, prices, flags, BAB commit |
| `runs/<id>/` | `transcript.jsonl` (every LLM and tool call; key values are redacted), `diff.patch`, `grade.txt` |
| `memory/` | The BAB data-dir snapshots each condition started from |


## Suites and ablations (gaps round)

| `--suite` | Tasks | What it measures |
|---|---|---|
| `core` (default) | 12 bugs under `evals/tasks/` | Ceiling / overhead when the repo itself reveals the fix |
| `tk` | 16 tasks under `evals/tasks-tk/` (8 colleague + 8 eval) | Whether shared memory helps when the fix needs team knowledge that is **not** in the repo. Full mode runs the 8 eval (variant) tasks; live seeding solves the 8 colleague (original) tasks. |

Extra `--conditions` (all optional; see `lib/conditions.mjs`):

| | Meaning |
|---|---|
| `L` | B's memory + lean toolset (search/learn/react only, short descriptions) |
| `F` | B's memory + the old MCP search advice, which filtered by kind standard, decision, practice (replaced in #30) |
| `N` | B's memory + one-line search-first nudge on the prompt |
| `R` | B's memory + top-3 search for the prompt injected before the first turn |
| `AR` | Auto-recorded memory (colleague finish summaries) instead of `bab_learn` bodies |
| `ST` / `CF` | Stale memory only / stale + current (tk suite) |
| `WR` | Plausible wrong memory only (core suite) |

```bash
pnpm eval --suite tk --conditions A,B,L,N,R --trials 1 --memory fixture --budget-usd 1
pnpm eval:retrieval --corpus all --queries all --distractors 100
```

Offline retrieval also accepts `--distractors N` (adds synthetic distractors from `fixtures/distractors-synthetic.json`) and `--queries v1|v2|all`.

Reference numbers for the TK / ablation / scale / hazard study live in the companion research notes (`GAPS.md` in the research tree that produced this package; not shipped here). Headline TK numbers measure the memory channel by construction - see Caveats below.

## Conditions (`--conditions`)

| | BAB connected | Memory in BAB |
|---|---|---|
| **A** | no | none (baseline) |
| **B** | yes | The colleague agent's own learnings, plus 20 distractors. `--memory fixture` (default in smoke) loads learnings that a `claude-sonnet-5-5` colleague actually recorded (`fixtures/colleague-learnings.json`, verbatim). `--memory live` (default in full) has a colleague agent with the same model solve the 6 original tasks now and record them. If it finishes without recording, it gets one nudge with BAB's own Stop-hook text. |
| **C** | yes | Distractors only. Measures what BAB's tools and instructions cost when nothing relevant is in memory. |
| **H** | yes | Hand-written notes (`fixtures/handwritten.json`) plus distractors. Labelled separately, because these are not agent-recorded. |

The distractors are BAB's 10 demo learnings from `scripts/seed-demo.sh`, plus 10 engineering near-misses that share vocabulary with the tasks but don't answer them.

**Isolation between runs:**
- Every run gets a fresh copy of its task repo.
- For B, C and H, every run also gets a **fresh BAB server** restored from the snapshot, so no run can see another run's memories.
- Job order is shuffled with a fixed seed.

## Configuration

| Env var | Default | |
|---|---|---|
| `BAB_EVAL_PROVIDER` | `anthropic` | `anthropic` (Messages API) or `openai` (any OpenAI-compatible `/chat/completions` with tools: OpenAI, xAI, OpenRouter, vLLM, ...) |
| `BAB_EVAL_MODEL` | `claude-haiku-5-5` (smoke), `claude-sonnet-5-5` (full) | |
| `BAB_EVAL_BASE_URL` | provider default | e.g. `https://api.x.ai/v1` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | | Read from the environment only; never written to disk |
| `BAB_EVAL_API_KEY_ENV` | | Name of a different variable holding the key |
| `BAB_EVAL_PRICE` | `lib/prices.mjs` | `"input,output,cacheRead,cacheWrite"` in USD per 1M tokens. Required for models not in the table, or costs show as 0 and the budget cap can't work. |
| `BAB_EVAL_STANDALONE` | `.next/standalone` | Use another BAB build |
| `BAB_EVAL_NODE` | the running `node` | Node >= 24 binary for the BAB server |

Flags (`node evals/run.mjs --help`): `--mode smoke|full`, `--conditions`, `--tasks`, `--trials`, `--memory fixture|live`, `--budget-usd`, `--parallel`, `--sandbox auto|bwrap|none`, `--max-turns`, `--max-seconds`, `--seed`, `--out`. Flags override the mode preset.

## What is measured

Per run:
- success (hidden tests pass)
- wall-clock time
- tokens (input, output, cache read, cache write) and cost
- LLM turns and tool calls
- BAB calls by tool
- **search rate** (called `bab_search`)
- **retrieval hit** and **rank** (a memory for this task's family came back, and at which position)
- **reacted** (`bab_react` helpful or confirm on it; BAB's own "I used this" signal)
- **recording rate** (called `bab_learn`)

How the report summarises them:
- Success uses a 95% Wilson CI (pooled; descriptive).
- Comparisons are paired per task (trials averaged within each task), against A and B vs C. They report the mean difference and ratio of means with BCa and paired-t 95% CIs over task clusters, plus an exact sign-flip permutation p (**uncorrected** for multiplicity). Claims not distinguishable from B at this n are not bolded.
- Each comparison is shown for all tasks, originals only, and variants only.

## Tasks

`tasks/<id>/` contains:
- `repo/`: what the agent sees.
- `hidden/`: extra tests, added at grading.
- `oracle/`: the reference fix, used only by `--validate`.
- `task.json`: prompt, test command, grade command, protected paths.

Grading restores the protected paths from the pristine repo, so editing tests never makes a task pass.

With bubblewrap available, the agent's shell sees only its repo (at `/work`), with no network and a cleared environment, so hidden tests and reference fixes are unreachable. Without it (`--sandbox none`, or a runner that blocks user namespaces), commands run in the repo with a cleared environment. The report records which mode ran, and any command mentioning `evals/tasks`, `oracle` or `hidden` is counted in `suspicious_cmds`.

There are 6 families. Each has an original task (the one the colleague solved) and a related-but-different variant:

| Family | Original | Variant |
|---|---|---|
| csv-bom | `f1-orig-csv-import`: missing column on an Excel export (UTF-8 BOM) | `f1-var-pricelist`: same cause, silently imports 0 rows |
| hash-randomization | `f2-orig-flaky-digest`: flaky tie order from set iteration | `f2-var-disk-cache`: `hash()` cache keys miss after restart |
| money-rounding | `f3-orig-invoice-rounding`: float `round()`, off by one cent | `f3-var-payout-split`: plus remainder allocation |
| env-coercion | `f4-orig-env-bool`: `bool("false")` is True | `f4-var-dataclass-flags`: same, via a dataclass caster |
| regex-semantics | `f5-orig-username-newline`: `$` matches before `\n` | `f5-var-slug-cdn`: plus Unicode `\w` |
| js-date-only-utc | `f6-orig-due-date` (Node): `new Date("YYYY-MM-DD")` is UTC | `f6-var-overdue-filter` (Node) |

To add a task, create the four parts above. `pnpm eval:validate` must show it failing as shipped and passing with the oracle.

## Retrieval eval

```bash
pnpm eval:retrieval [--corpus colleague|handwritten] [--min-recall5 0.85] [--min-mrr 0.80]
```

The queries are in `fixtures/retrieval-queries.json`, each tagged with the family whose memory should answer it:
- **symptom** queries: what an agent knows before diagnosing.
- **observed** queries: what real agents typed during the benchmark runs.

Each query runs twice:
- plain;
- with `kind: [standard, decision, practice]`, the filter BAB's MCP instructions used to suggest before changing a repo (until #30). That filter excludes kind `learning`, which is what agents record, so this variant shows how much it hid.

The run exits non-zero below the thresholds. CI uses thresholds just under the values measured when the eval was added.

## Reference numbers (2026-10-19, BAB edeb801)

| | recall@1 | recall@5 | MRR |
|---|---|---|---|
| Retrieval, colleague corpus, plain | 0.88 | 0.94 | 0.90 |
| Retrieval, colleague corpus, kind filter | 0.00 | 0.00 | 0.00 |
| Retrieval, hand-written corpus, plain | 0.69 | 0.86 | 0.77 |

Agent eval with the same tasks and conditions (core: 12 tasks × A/B/C × 3 trials; TK full mode: 8 eval variants), from the study this suite was extracted from:
- **`claude-sonnet-5-5`:** 100% success in every condition. B/A cost ratio 1.50 (95% CI 1.36-1.69); C/A 1.40 (1.31-1.52); turns unchanged.
- **`claude-haiku-5-5`:** B/A cost ratio 1.94 (1.86-2.04); turns 1.30 (1.21-1.39).
- **Why BAB costs more:** its 10 tool definitions and instructions add about 8.6k input tokens to every LLM call.
- **Ceiling:** these tasks are easy enough that both models solve them without memory. Treat the agent eval as a measure of overhead and of how agents *use* BAB (search rate 22-50%), not as proof of benefit. Harder tasks, where rediscovery is expensive, are the most useful addition.

## CI

`.github/workflows/evals.yml`:
- **On pull requests** touching `lib/`, `app/api/`, `app/mcp/` or `evals/`: build, then `eval:validate`, then `eval:retrieval` with thresholds. No secrets are needed.
- **On manual dispatch:** the agent eval (`smoke` or `full`, model and budget as inputs), with `ANTHROPIC_API_KEY` from repo secrets. The summary goes to the job summary, and results and transcripts are uploaded as artifacts.


## Caveats

- **TK suite measures the memory channel by construction.** Repos omit a fictional vendor spec, the prompt names the vendor, the colleague memory is that spec (title/error strings overlapping the prompt), and hidden tests check those values. Condition A can only guess. Report TK success deltas as evidence that the memory path works, not as an estimate of how often BAB helps on real work.
- **Retrieval recall is an upper bound** unless you pass `--hard-distractors` (vendor-overlap distractors) and `--queries blind|hard` (blind-written queries). The CI baseline still uses the original distractor set; the hard eval is reported alongside it.
- Workspaces and default `--out` live under `$BAB_EVAL_SCRATCH` / `$TMPDIR/bab-evals-*`, outside the repo/tasks tree. `--sandbox none` is an explicit opt-in; CI always passes `--sandbox bwrap`.


- Live memory mode draws colleague memory **once per `--out` directory** and shares that draw across all trials (frozen for `--resume`). Independent per-trial draws are not the default (they multiply seed cost).

## Limitations

- The agent is a minimal MCP-capable loop with bash, read, write and finish tools, not Claude Code. The Claude Code plugin's hooks are not exercised, except that live seeding replays the Stop-hook capture nudge text.
- Core has 12 tasks (6 original + 6 variant families); TK full mode scores 8 eval variants. With n≈8 task clusters the smallest exact sign-flip p is 1/256 ≈ 0.004; treat CIs as descriptive.
- Prices in `lib/prices.mjs` are list prices copied by hand. Check them before quoting costs.

## Leak / cheat audit

`node evals/scripts/audit-leak-cheat.mjs [runsRoot]` scans completed run trees for symlink creation, `/proc/*/environ`, `hidden/`/`oracle/` access, `suspicious_cmds>0`, and `sk-ant-` material in transcripts. Point it at the **research** runs tree (not shipped here). Older metas may omit the `sandbox` field (345 in the Oct 2026 research tree); that is an older harness, not proof of a cheat.
