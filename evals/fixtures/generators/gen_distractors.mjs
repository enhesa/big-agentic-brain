// Exp 3 corpus: ~1000 synthetic distractor memories written by claude-haiku-5-5 (labelled synthetic), filtered so none
// states a target fact of the core or tk families. Output: evals/fixtures/distractors-synthetic.json
import fs from "node:fs";
const AREAS = ["Kubernetes deployments", "Terraform and cloud infra", "PostgreSQL operations", "Redis and caching", "Kafka and event streaming",
  "React frontend", "CSS and design system", "iOS app releases", "Android builds", "CI pipelines", "Docker images", "observability and alerting",
  "application security", "SSO and access requests", "data warehouse", "dbt models", "Airflow jobs", "ML model training", "product analytics",
  "marketing operations", "sales operations and CRM hygiene", "legal and contract review", "HR processes", "accounts payable", "customer support tooling",
  "localization and translations", "accessibility", "Elasticsearch", "CDN and edge caching", "DNS and networking", "git workflow", "code review norms",
  "testing practices", "performance tuning", "API design conventions", "logging conventions", "incident response", "vendor management", "office and IT", "mobile push notifications"];
const BANNED = "byte order marks or utf-8-sig; Python hash randomization or PYTHONHASHSEED or set iteration order; float rounding of money, cents or Decimal; parsing booleans from environment variables; regex $ and trailing newlines or Unicode \\w in usernames or slugs; JavaScript new Date('YYYY-MM-DD') being UTC; ERP import file formats; webhook or request signing with HMAC; Retry-After or 429 backoff for a geocoding service; bank settlement cut-off times; customer-number check digits; newsletter unsubscribe headers or email streams; JWT aud/iss/scope claims or clock skew; currency minor units for a payment provider";
const FILTER = /\b(ledgerly|shipfast|geo-api|kestrel|orion|postbird|gatekeeper|paylane)\b|utf-8-sig|\\ufeff|byte order mark|\bBOM\b|PYTHONHASHSEED|hash randomi[sz]ation|bool\(["']false|List-Unsubscribe|Retry-After-Ms|minor unit|new Date\(["']\d{4}-\d\d-\d\d["']\)|ROUND_HALF_UP|check digit|cut-?off time/i;
const key = process.env.ANTHROPIC_API_KEY;
const PRICE = { input: 0.10, output: 0.50 };
let cost = 0;
async function batch(area, i) {
  const prompt = `Write 25 distinct memories that engineers, analysts and other staff at a mid-size software company recorded in their team's shared memory tool, all about: ${area}. Each is a concrete, reusable team fact: a gotcha, house rule, deploy step, internal tool quirk or verified answer, with specifics (internal tool or service names you invent, commands, settings, numbers). 2 to 5 sentences each. Vary the style. Do NOT write about any of these topics: ${BANNED}.
Return only a JSON array of objects {"title": string (under 120 chars), "body": string, "tags": [one team tag, one or two topic tags]}.`;
  for (let attempt = 0; attempt < 6; attempt++) {
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 8000, temperature: 1, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(240_000),
    });
    } catch (e) { console.log(`batch ${i} fetch error ${e.cause?.code ?? e.name}`); await new Promise((s) => setTimeout(s, 5000)); continue; }
    if (r.status === 401 || r.status === 403) throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    if (!r.ok) { console.log(`batch ${i} HTTP ${r.status}`); await new Promise((s) => setTimeout(s, 3000 * (attempt + 1))); continue; }
    const j = await r.json();
    cost += (j.usage.input_tokens * PRICE.input + j.usage.output_tokens * PRICE.output) / 1e6;
    const text = j.content.map((c) => c.text ?? "").join("");
    try {
      const arr = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
      return arr.filter((x) => x && typeof x.title === "string" && typeof x.body === "string").map((x) => ({ ...x, tags: Array.isArray(x.tags) ? x.tags.slice(0, 3).map(String) : [], area }));
    } catch { console.log(`batch ${i} unparsable (stop=${j.stop_reason})`); continue; }
  }
  return [];
}
const all = [];
for (let i = 0; i < AREAS.length; i += 4) {
  const got = await Promise.all(AREAS.slice(i, i + 4).map((a, k) => batch(a, i + k)));
  for (const g of got) all.push(...g);
  console.log(`batches ${i + 4}/${AREAS.length}: ${all.length} memories, $${cost.toFixed(4)}`);
}
const seen = new Set();
const kept = [];
const removed = [];
for (const m of all) {
  const k = m.title.toLowerCase();
  if (seen.has(k)) continue;
  seen.add(k);
  (FILTER.test(`${m.title} ${m.body}`) ? removed : kept).push(m);
}
fs.writeFileSync("/workspace/bab-experiments/bab-evals-pr/evals/fixtures/distractors-synthetic.json", JSON.stringify({
  _provenance: `Synthetic distractor memories generated 2026-10-19 by claude-haiku-5-5 (40 areas x 25), deduplicated by title and filtered so none states a target fact of the core or tk families (${removed.length} removed by the filter). Not real team knowledge. Generation cost $${cost.toFixed(4)}.`,
  learnings: kept,
}, null, 1));
fs.writeFileSync("/workspace/bab-experiments/gaps/distractors-removed.json", JSON.stringify(removed, null, 1));
console.log(`kept ${kept.length}, removed ${removed.length}, cost $${cost.toFixed(4)}`);
