// Command Center helpers shared by the contract eval (evals/cc-contract.mjs) and the LLM suites
// (evals/lib/cc-suite.mjs): a throwaway BAB with Command Center on, a person who switches it on
// through the sign-in proxy (the page, never an agent), and an agent MCP client bound to a device.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { startBab } from "./bab-server.mjs";
import { McpClient } from "./mcp.mjs";

/**
 * BAB with Command Center on and the proxy identity headers trusted, so the harness can act as the
 * signed-in viewer on /command-center/enable and /disable. Nothing but the harness reaches it.
 */
export function startCcBab(dir) {
  return startBab({
    dataDir: path.join(dir, "bab-data"),
    logFile: path.join(dir, "bab-server.log"),
    env: { BAB_COMMAND_CENTER: "true", BAB_TRUST_PROXY_IDENTITY: "1", BAB_TRUST_PROXY_WITHOUT_SECRET: "1" },
  });
}

/** A test identity: an example.com person with one fresh device id (generated, never a literal). */
export function ccPerson(n = 1) {
  return { email: `cc.person.${n}@example.com`, name: `Casey Example ${n}`, device: randomBytes(32).toString("hex") };
}

// BAB allows each person a bucket of 20 Command Center calls that refills at 60 a minute. The
// harness keeps a slightly smaller bucket of its own, so its reads never turn an agent's call into a 429.
const BURST = 15;
const PER_MS = 50 / 60_000;
const buckets = new Map();
export async function pace(person) {
  const b = buckets.get(person.email) ?? { tokens: BURST, at: Date.now() };
  buckets.set(person.email, b);
  for (;;) {
    const now = Date.now();
    b.tokens = Math.min(BURST, b.tokens + (now - b.at) * PER_MS);
    b.at = now;
    if (b.tokens >= 1) break;
    await new Promise((r) => setTimeout(r, Math.ceil((1 - b.tokens) / PER_MS) + 20));
  }
  b.tokens -= 1;
}

function viewerHeaders(origin, person) {
  return {
    origin,
    "content-type": "application/json",
    "x-auth-request-user": `eval-${person.email}`,
    "x-auth-request-email": person.email,
    "x-auth-request-preferred-username": person.name,
  };
}

/** The person flips their own switch on the page (POST /command-center/enable|disable as the viewer). */
export async function setSwitch(origin, person, on) {
  const res = await fetch(`${origin}/command-center/${on ? "enable" : "disable"}`, {
    method: "POST",
    headers: viewerHeaders(origin, person),
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`/command-center/${on ? "enable" : "disable"} ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/**
 * The agent's MCP connection: the BAB plugin's device header, identified once with bab_identify,
 * so it is a bound identity like a real installed plugin.
 */
export async function ccAgent(origin, person, label = "Eval laptop") {
  const mcp = await new McpClient(origin, person.email, person.name, {
    "x-bab-device": person.device,
    "x-bab-device-label": label,
  }).init();
  const id = await mcp.call("bab_identify", { email: person.email, name: person.name });
  if (id.isError) throw new Error(`bab_identify failed: ${id.text.slice(0, 300)}`);
  const call = mcp.call.bind(mcp);
  mcp.call = async (name, args) => {
    if (name === "bab_command_center") await pace(person);
    return call(name, args);
  };
  return mcp;
}

/** A second machine of the same person (another device id). */
export function otherDevice(person) {
  return { ...person, device: randomBytes(32).toString("hex") };
}

/** GET /api/command-center/<id> as the person's device: the full record with server fields, or null on 404. */
export async function getRecord(origin, person, id) {
  await pace(person);
  const res = await fetch(`${origin}/api/command-center/${encodeURIComponent(id)}`, {
    headers: { "x-bab-device": person.device },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET /api/command-center/${id} ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.record ?? body;
}

/** GET /api/command-center as the person's device: { initiatives, dataHealth, ... }. */
export async function listRecords(origin, person) {
  await pace(person);
  const res = await fetch(`${origin}/api/command-center`, {
    headers: { "x-bab-device": person.device },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET /api/command-center ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/** The skill as BAB serves it, with this server's origin filled in. */
export async function skillText(origin) {
  const res = await fetch(`${origin}/instructions/command-center.md`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET /instructions/command-center.md ${res.status}`);
  return res.text();
}

/** Splits a skill file into its frontmatter fields and body. */
export function splitSkill(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

/** Parses a tool answer that should be JSON; returns null when it is a sentence. */
export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A credential-shaped value built at runtime, so no secret literal sits in the repo. It matches
 * the generic API-key pattern BAB's redact() masks.
 */
export function fakeSecret() {
  return ["sk", "proj", randomBytes(24).toString("base64url")].join("-");
}
