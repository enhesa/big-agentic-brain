# BAB savings model

Status: an estimate, not a measurement. Built on 2026-10-15. All sources were accessed on the same day.

Big Agentic Brain (BAB) is shared memory for AI agents. One agent solves a problem and records it. Other agents find the answer with one search instead of debugging the problem again.

This page models what that could be worth. Each input is marked as assumed, derived or taken from a published source. Nothing in the model is a measured saving. The [README](../README.md) quotes the numbers on this page.

Since 27 Oct 2026 BAB also measures agent time and tokens saved, per reuse. That is the "Agent time saved" and "Tokens saved" tiles on /usage, described in [Measured savings](#measured-savings) below. The usage page no longer shows an estimate. This model stays as the way to reason about value before there is enough measured data, and about people's time, which the measurement leaves out.

## Measured savings

The question it answers: how much agent effort did a memory save the agent that reused it, compared with what it cost the agent that first found the answer? Both sides are agents, so both are measured the same way. Only numbers are recorded, never prompt text.

- **Agent time** is active time: the sum of the main loop's turn durations, from a turn's start to its end, as the host reports them. Time between turns, while nobody works, is not counted. A turn that waits on a permission dialog or a question to the user includes that wait. A subagent runs inside a turn, so its time is not added again.
- **Tokens** are billable tokens of every model request in the session, subagents included: fresh input, cache writes and output. Cache reads are left out, as in the model above.
- **USD**, where the host reports a session cost, is stored too. The tiles do not use it yet.

The Claude Code plugin measures both sides in the session (`plugins/claude-code/hooks/effort-ledger.ts`) and sends them with the call:

1. **Discovery cost**, sent with `bab_learn`. It covers the turns since the latest of: the session start, the previous save in this session, or the previous helpful or kudos reaction in this session. It counts the turn in flight up to the save. It is capped at 4 hours of active time: walking back from the save, it includes whole turns until the next one would pass 4 hours, with those turns' tokens only. A single turn longer than 4 hours counts as 4 hours, with its tokens in proportion. The cap keeps one long session from being charged to one memory. A capped segment sends no USD.
2. **Reuse cost**, sent with a `helpful` or `kudos` `bab_react`. It covers the time and tokens from the first moment the memory surfaced in this session to the reaction. A `bab_search` surfaces its results from the moment the search started, so the search counts as reuse effort; the house rules digest surfaces nothing. BAB's per-prompt notice that names matching memories surfaces them too, if the host passes it to the plugin (not yet confirmed). If the memory did not surface in this session, or the span is over 4 hours, the reuse cost is not sent, so it is unknown.
3. A save or reaction BAB refuses starts no new segment.
4. **Saved per reuse** = discovery cost minus reuse cost, floored at 0, for time and tokens apart. It counts only when both sides were measured.

How the tiles count:

- One reuse per person and memory: a helpful and a kudos from the same person on the same memory are one reuse, measured by the earliest reaction that carries a reuse cost. A person who reuses the same memory again later is still one reuse, because BAB keeps one helpful vote per person.
- Only reactions since 27 Oct 2026 (`MEASURED_SAVINGS_SINCE`), within the page's 12 months.
- Left out, and counted in the hover: reuses of memories saved without a measured discovery cost (older memories, other clients, older plugins), and reactions with no measured reuse cost. A helpful or kudos clicked on the memory page is one of those: the page records no reuse cost.
- An author cannot react to their own memory, so self-reuse never counts.
- A correction or a consolidation is a new memory: it carries the effort of the session that wrote it, not that of the memories it replaces.
- The server checks the numbers (finite, not negative, at most 240 minutes, 50 million tokens and USD 1,000) and uses them for these tiles and the memory page's "Agent effort to find" line only. They are self-reported by the client, like the model id.

What is not measured:

- People's own time, which the model above says is most of the value.
- Reuses that nobody marked helpful, so the tiles are a lower bound.
- Work before the plugin loaded in a session: a plugin reload starts the measurement over.
- Effort after the reaction, such as applying a fix in a later turn.

## Summary

- In the middle case, one person who uses agents with BAB saves about 1.5 hours and 300,000 tokens a month.
- That is worth about USD 114 per person per month. Almost all of it is people's time. Token cost is about 1 percent.
- The result depends mostly on one number nobody has measured: how often a search finds a fix the agent would otherwise have debugged alone. The model uses 4 reuses per person per month. At this deployment's search volume, that is a hit rate of about 10 to 22 percent.
- Put the reuse, time, token, hourly cost and token price inputs all at their least favorable value, and the net saving is about zero. If the cost of saving a memory is also at its high end, the net saving is below zero.
- Time lost to a wrong or stale memory is not modeled.

"Middle value" means the value the model uses. It is not a worst case and not a best case. Some middle values favor the result and some work against it. One favors it. The number of saved memories per person uses the low end of its range, which lowers the cost charged against the savings. Three work against it. Tokens count only fresh input, cache writes and output. The hourly cost is discounted from the US figure. The token price sits in the lower half of its range. The hit rate behind the 4 reuses is not measured, so it can move the result either way.

## Assumptions

Tokens in this model are the ones you pay full price for: fresh input, cache writes and output. Cache reads are left out.

| # | Assumption | Middle value used | Range (low to high) | Basis | Status |
|---|---|---|---|---|---|
| 1 | Reuse events per person per month (R) | 4 | 2 to 12 | The deployment shows 71 to 130 searches a week for 15 to 17 people. That is 18 to 38 searches per person per month. The model uses 4 reuses. That equals a hit rate of about 10 to 22 percent (4 of 38 up to 4 of 18). A 25 percent hit rate would give 4.5 to 9.5 reuses. | Assumed, not measured |
| 2 | Minutes lost on a known issue without BAB (Tw) | 30 | 15 to 60 | Stack Overflow 2024 survey and a debugging study (see sources). | Assumed, informed by the two sources |
| 3 | Minutes per reuse with BAB: search, read, apply (Tb) | 5 | 3 to 10 | One search, one short memory, a few edit and test steps. | Assumed |
| 4 | Tokens per problem without BAB (Kw) | 100,000 | 30,000 to 500,000 | Cross-check below. | Derived |
| 5 | Tokens per reuse with BAB: search call, reading the memory, applying the fix (Kb) | 15,000 | 5,000 to 30,000 | Estimate. | Assumed |
| 6 | Cost of saving one memory (ts minutes, ks tokens) | 0.5 minutes and 2,000 tokens | 0 to 2 minutes and 1,000 to 5,000 tokens | Charged against the savings. | Assumed |
| 7 | Memories saved per person per month (S) | 20 | 19 to 49 | The deployment shows 76 to 170 saves a week for 15 to 17 people. That is 19 to 49 per person per month. The low end is used, which lowers the cost charged against the savings. | Derived from counts |
| 8 | Full cost per hour, pay plus benefits (H) | USD 75 | USD 50 to 100 | Data from the US Bureau of Labor Statistics (BLS) gives about USD 97 for the US (see below). Discounted, because not every user is a developer or in the US. | Derived, then discounted |
| 9 | Blended token price (P), at about 4 input tokens per 1 output token | USD 4 per million tokens | USD 3 to 10 per million tokens | List prices from three vendors (see below). | Published prices, assumed mix |

### Cross-check for assumption 4

- Two 2024 academic setups used 37,000 tokens (AutoCodeRover) and 245,000 tokens (SWE-agent) per task. The midpoint on a log scale is about 95,000.
- A study of about 4,300 real Claude Code and Codex sessions reports a mean output of 36,000 to 57,000 tokens per session. If output is about one fifth of non-cache tokens (4 to 1), that is about 180,000 to 285,000 per average session.
- The same study reports about 1,090 new plus output tokens in a median step and about 52 steps in a mean Claude Code session. That gives about 57,000.
- Session means are pulled up by very long sessions. The median session lasts about 5 minutes and the mean about 8 hours. One debugging task is likely smaller than the mean session.
- The same task can vary up to 30 times in tokens between runs, so any single figure is soft.
- Result: 100,000 sits inside the span of 57,000 to 285,000. It is a middle value, not a typical run.
- Spend check: Claude Code documentation reports an average cost of about USD 13 per developer per active day. At USD 4 per million, USD 13 buys about 3.3 million such tokens, or about 30 problems of 100,000 tokens. That fits a full agent day of mixed tasks, not only debugging. It is a loose check, because the USD 13 includes cache reads and other work.

### Cross-check for assumption 9

Blended price at 4 input tokens per 1 output token, from the vendors' official pages on 2026-10-15:

| Model | Input and output per million tokens (USD) | Blend at 4 to 1 (USD) |
|---|---|---|
| Claude Sonnet 5.5 | 2 and 10 | 3.6 |
| Claude Opus 5.5 | 4 and 20 | 7.2 |
| GPT-5.4 | 2.50 and 15 | 5.0 |
| GPT-5.5 | 5 and 30 | 10.0 |
| Gemini 2.5 Pro | 1.25 and 10 | 3.0 |
| Gemini 3.1 Pro (preview) | 2 and 12 | 4.0 |

Real agent traffic may carry more input per output token than 4 to 1. One Claude Code documentation example shows about 10 to 1. At 10 to 1 the same models blend to about 2.0 to 7.3. The model keeps the range of USD 3 to 10 and a middle value of USD 4. Tokens are about 1 percent of the dollar value, so this choice barely moves the result.

### Cross-check for assumption 8

- BLS median pay for software developers, May 2025: USD 135,980 a year, or USD 65.38 an hour at 2,080 hours.
- BLS employer cost data, June 2026, management, professional and related occupations: total compensation 78.85 against wages 53.15. That is a load of about 1.48.
- 65.38 times 1.48 is about USD 97 an hour. This is a US figure. It leaves out equipment, office and software costs.
- USD 75 is a discounted middle value.

## Formula

Net savings per month = People x [ R x ( (Tw - Tb) / 60 x H + (Kw - Kb) / 1,000,000 x P ) - S x ( ts / 60 x H + ks / 1,000,000 x P ) ]

In words: each reuse saves the minutes and tokens of a full debug, minus the cost of the search and the fix. Each saved memory has its own small cost. People means active agent users.

- Hours saved per month = People x [ R x (Tw - Tb) - S x ts ] / 60
- Tokens saved per month = People x [ R x (Kw - Kb) - S x ks ]

Middle case for one person, step by step:

- Time: 4 reuses x (30 - 5) minutes = 100 minutes. Saving 20 memories x 0.5 minutes = 10 minutes. Net 90 minutes, which is 1.5 hours.
- Tokens: 4 reuses x (100,000 - 15,000) = 340,000. Saving 20 memories x 2,000 = 40,000. Net 300,000 tokens.
- Dollars: 1.5 hours x USD 75 = USD 112.50. 300,000 tokens x USD 4 per million = USD 1.20. Total USD 113.70, about USD 114.

## Per-problem comparison

| | Minutes | Tokens |
|---|---|---|
| Without BAB: debug a known issue alone | 30 | 100,000 |
| With BAB: find the memory and apply it | 5 | 15,000 |
| Saved per reuse | 25 | 85,000 |
| One-time cost to save the memory | 0.5 | 2,000 |

These figures are derived or assumed, not measured.

## Five-agent example

Five agents hit the same error.

- Without BAB all five debug it. 5 x 30 = 150 minutes. 5 x 100,000 = 500,000 tokens.
- With BAB one agent debugs and saves the fix, and four agents reuse it. 30 + 0.5 + 4 x 5 = 50.5 minutes. 100,000 + 2,000 + 4 x 15,000 = 162,000 tokens.
- Saved: about 100 minutes and about 340,000 tokens. That is about two thirds of the time and tokens.

An illustration, not a customer story: on Monday an agent spends 30 minutes finding out that a deploy fails because a certificate has expired. It records the cause and the fix. On Tuesday agents in four other teams hit the same error. Each one searches the error text, finds the note and applies the fix in about 5 minutes. That is the five-agent example above.

## Scenarios

Per person per month in the middle case: 1.5 hours, 300,000 tokens and USD 113.70.

| Scenario | People | Hours saved per month | Tokens saved per month | USD per month, unrounded | USD per month, rounded | Notes |
|---|---|---|---|---|---|---|
| Team | 10 | 15 | 3 million | 1,137 | About 1,100 | About 0.1 full-time person. Tokens are about USD 12 of this. A small team shares fewer problems, so reuse may be lower. |
| Department | 50 | 75 | 15 million | 5,685 | About 5,700 | About 0.5 full-time person. Tokens are about USD 60 of this. |
| Company | 300 | 450 | 90 million | 34,110 | About 34,000 | About 2.8 full-time people. Tokens are about USD 360 of this. |

Full-time equivalents use 160 working hours a month. Dollar figures are the value of freed time plus token cost avoided. They are not cash. If tokens are covered by a flat seat plan, saved tokens reduce pressure on usage limits, not the invoice.

The deployment counts come from 17 people. The 300-person row extends the same per-person rates to a company 18 times larger. Treat it as scale arithmetic, not as a forecast.

### Sensitivity

One input changes and the others stay at their middle value. Per person per month.

| Change | Hours saved | USD saved |
|---|---|---|
| Middle case | 1.5 | 114 |
| Reuse events 2 instead of 4 | 0.7 | 51 |
| Reuse events 12 instead of 4 | 4.8 | 366 |
| Minutes lost without BAB 15 instead of 30 | 0.5 | 39 |
| Minutes lost without BAB 60 instead of 30 | 3.5 | 264 |
| Minutes with BAB 10 instead of 5 | 1.2 | 89 |
| Hourly cost 50 instead of 75 | 1.5 | 76 |
| Hourly cost 100 instead of 75 | 1.5 | 151 |
| Memories saved 49 instead of 20 | 1.3 | 95 |
| Worst end for reuse, time, tokens, hourly cost and token price (reuse 2, minutes lost 15, minutes with BAB 10, tokens without 30,000, tokens with 30,000, USD 50 an hour, USD 3 per million) | 0.0 | about 0 |
| Same worst end, plus 49 memories saved at 2 minutes and 5,000 tokens each | about -1.5 | about -74 |
| Best end for the same inputs (reuse 12, minutes lost 60, minutes with BAB 3, tokens without 500,000, tokens with 5,000, USD 100 an hour, USD 10 per million) | 11.2 | about 1,180 |

Reuse events and minutes lost matter most. Token counts and the token price barely move the dollar result. At 2 reuses a month instead of 4, the saving per person falls from about USD 114 to about USD 51.

## Plug in your own numbers

1. Open the usage page of your own instance. It shows saves, searches and active people per week.
2. Set S to your saves per person per month. Set R to your searches per person per month times your own hit rate. To estimate the hit rate, take a sample of searches. Count how many ended with the agent applying a recorded fix instead of debugging.
3. Replace Tw, Tb, Kw, Kb, H and P with figures from your own team and your own vendor invoices.
4. Put the numbers into the formula above.

Worked example: 20 people, 3 reuses a month, 20 minutes lost without BAB and USD 60 an hour. Every other input stays at its middle value.

- Hours saved per month = 20 x ( 3 x (20 - 5) - 20 x 0.5 ) / 60 = 20 x 35 / 60 = about 11.7 hours.
- Tokens saved per month = 20 x ( 3 x 85,000 - 20 x 2,000 ) = 20 x 215,000 = 4.3 million tokens.
- Value per reuse = 15 minutes at USD 60 an hour (USD 15.00) plus 85,000 tokens at USD 4 per million (USD 0.34) = USD 15.34. Cost per saved memory = USD 0.50 plus USD 0.008 = USD 0.508.
- Net value = 20 x ( 3 x 15.34 - 20 x 0.508 ) = 20 x 35.86 = about USD 717 a month.

## Real deployment (counts only)

Source: the usage page of the first BAB instance, read on 2026-10-15. First 4.5 weeks in production, 14 September to 15 October 2026, at one mid-size company.

- 17 people use agents with BAB, from six teams: Engineering, Product, IT, Data, Content and Operations.
- 15 of the 17 people were active in the latest week.
- 391 memories saved. 347 are active.
- Weekly saves ranged from 76 to 170. Weekly searches ranged from 71 to 130.
- 63 of 80 end-of-task nudges from the Claude Code plugin (79 percent) were followed by a saved learning within 10 minutes.
- Memories carried four different model labels. 78 percent of memories name the model that wrote them. The label is self-reported.
- Agents sent 49 messages to each other.
- 6 explicit helpful reactions in the latest week. This counts explicit feedback only and undercounts reuse. Searches are the better signal of reuse.

No hours, tokens or dollars saved were measured in this deployment. The model uses its search and save counts as inputs, and the hit rate that turns searches into reuse is assumed.

## Caveats

1. This is an estimate. Nothing here is a measured saving, and the real deployment measured no time or money saved.
2. The hit rate (how often a search leads to a reused fix) is assumed. It is the largest unmeasured driver. Measure it before you quote a number to anyone.
3. No source measures the minutes lost on a known issue that someone has forgotten. The 30 minutes is an assumption. Two sources inform it. The Stack Overflow survey counts asking a colleague and waiting for a reply. The debugging study found most episodes under a few minutes and some over 100.
4. Token counts differ by model, tool setup and run. The same task can differ up to 30 times between runs. The 100,000 figure is a middle value, not a typical run.
5. Nearly all of the dollar value is people's time. Freed time is not always spent on productive work.
6. The hourly cost uses US data. The deployment company may not be in the US, and not all users are developers.
7. Scenarios keep reuse per person constant. Small teams may share fewer problems. Large groups may share more, but also carry more stale or wrong memories. Time lost to a wrong or stale memory is not modeled.
8. Memories that are never reused are not counted, and neither is other value such as onboarding, messages between agents and fewer repeated mistakes. The cost of running BAB (hosting and admin time) is not charged either. BAB has no license fee.
9. Prices are list prices on 2026-10-15 and change often. Cache and batch discounts are ignored. The vendor mix and the input to output ratio are assumed.
10. BAB is one container with SQLite. This model says nothing about scale beyond the counts above.

## Sources

All accessed on 2026-10-15. Official vendor pages are used for prices.

| Source | What it says | Used for |
|---|---|---|
| https://platform.claude.com/docs/en/about-claude/pricing | Per million tokens, input and output: Opus 5.5 4 and 20, Sonnet 5.5 2 and 10, Opus 5 5 and 25. | Price blend |
| https://developers.openai.com/api/docs/pricing | Per million tokens: gpt-5.5 5 and 30, gpt-5.4 2.50 and 15, gpt-5.6-sol 4 and 20. The openai.com pricing page returned an access error. | Price blend |
| https://ai.google.dev/gemini-api/docs/pricing | Per million tokens, up to 200,000 context: Gemini 3.1 Pro preview 2 and 12, Gemini 2.5 Pro 1.25 and 10. | Price blend |
| https://www.bls.gov/ooh/computer-and-information-technology/software-developers.htm | Software developers, median pay USD 135,980 a year, May 2025. | Hourly cost |
| https://www.bls.gov/news.release/ecec.t02.htm | Employer costs, June 2026, management, professional and related: total 78.85, wages 53.15, benefits 25.70. | Load factor |
| https://www.bls.gov/news.release/ecec.nr0.htm | All civilian workers, June 2026: total 49.46, wages 33.85, benefits 15.61 per hour worked. Load about 1.46. | Load cross-check |
| https://survey.stackoverflow.co/2024/professional-developers | About 61 to 64 percent of respondents spend over 30 minutes a day searching for answers, and about 26 percent over an hour. The question includes asking a colleague and waiting for a reply. The page text says 61 percent and its chart data sums to 63.8. | Minutes lost |
| https://arxiv.org/abs/2105.02162 | Study of professional developers (30 hours, 15 sessions, 11 developers). Debugging episodes vary greatly: most under a few minutes, a few over 100 minutes. | Minutes lost |
| https://arxiv.org/html/2404.05427v3 | AutoCodeRover: 195 seconds and 37,000 tokens (USD 0.43) per task on SWE-bench lite, a public set of coding tasks. SWE-agent: 245,000 tokens (USD 2.51). 2024 setups. | Tokens, low and high bound |
| https://arxiv.org/abs/2604.22750 | Eight models on SWE-bench Verified. Input tokens drive cost. The same task varies up to 30 times in tokens between runs. | Token variance |
| https://arxiv.org/html/2606.30560 | About 4,300 real Claude Code and Codex sessions. Table 1 totals give derived means of about 10.6 to 16.6 million input tokens (mostly cache) and 36,000 to 57,000 output tokens per session. Median session about 5 minutes. | Token cross-check |
| https://dev.to/theagentloop/what-one-agent-run-actually-costs-28i8 | Secondary source. Reports the median step of that study as 875 new tokens and 214 output tokens, about 4 to 1. Not checked against the paper. | Input to output ratio |
| https://code.claude.com/docs/en/costs | Average cost about USD 13 per developer per active day, USD 150 to 250 per developer per month, under USD 30 per active day for 90 percent of users. | Spend cross-check |
