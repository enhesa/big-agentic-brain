// LLM providers with tool calling, normalized to one turn shape:
// { text, toolCalls: [{ id, name, args }], usage: { input, output, cacheRead, cacheWrite }, stop, assistant: [native msgs] }
// API keys are read from the environment and never logged; redact() scrubs them from any text we persist.

const RETRY = new Set([429, 500, 502, 503, 504, 529]);

export function redact(text) {
  let out = String(text);
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 16 && /KEY|TOKEN|SECRET/.test(k) && out.includes(v)) out = out.split(v).join("[REDACTED]");
  }
  return out;
}

async function post(url, headers, body, { retries = 6, timeoutMs = 300_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return await res.json();
      const msg = redact((await res.text()).slice(0, 800));
      if (RETRY.has(res.status) && attempt < retries - 1) {
        await sleep(Math.min(60_000, 4000 * 2 ** attempt));
        continue;
      }
      const err = new Error(`HTTP ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    } catch (e) {
      if (e.status || attempt >= retries - 1) throw e;
      await sleep(5000 * (attempt + 1));
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Anthropic {
  constructor(cfg) {
    this.model = cfg.model;
    this.key = requireKey(cfg.keyEnv ?? "ANTHROPIC_API_KEY");
    this.base = cfg.baseUrl ?? "https://api.anthropic.com";
    this.maxTokens = cfg.maxTokens ?? 4096;
  }
  toolSpec(name, description, schema) {
    return { name, description, input_schema: schema };
  }
  userMsg(text) {
    return { role: "user", content: text };
  }
  toolResults(results) {
    return [
      {
        role: "user",
        content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.text, is_error: r.isError })),
      },
    ];
  }
  appendText(messages, text) {
    const last = messages.at(-1);
    if (last?.role === "user" && Array.isArray(last.content)) last.content.push({ type: "text", text });
    else messages.push(this.userMsg(text));
  }
  async chat(system, tools, messages, opts = {}) {
    // Prompt caching on the static prefix and the conversation tail, identical for every condition.
    const msgs = structuredClone(messages);
    const last = msgs.at(-1);
    if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
    last.content.at(-1).cache_control = { type: "ephemeral" };
    const tl = tools.map((t) => ({ ...t }));
    if (tl.length) tl.at(-1).cache_control = { type: "ephemeral" };
    const r = await post(
      `${this.base}/v1/messages`,
      { "x-api-key": this.key, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: tl,
        messages: msgs,
      },
      { timeoutMs: opts.timeoutMs ?? 300_000 },
    );
    const u = r.usage ?? {};
    return {
      text: r.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
      toolCalls: r.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
      stop: r.stop_reason,
      usage: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
      assistant: [{ role: "assistant", content: r.content }],
    };
  }
}

/** Any OpenAI-compatible /chat/completions endpoint with tool calling (OpenAI, xAI, OpenRouter, vLLM, ...). */
export class OpenAICompat {
  constructor(cfg) {
    this.model = cfg.model;
    this.key = requireKey(cfg.keyEnv ?? "OPENAI_API_KEY");
    this.base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.maxTokens = cfg.maxTokens ?? 4096;
  }
  toolSpec(name, description, schema) {
    return { type: "function", function: { name, description, parameters: schema } };
  }
  userMsg(text) {
    return { role: "user", content: text };
  }
  toolResults(results) {
    return results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.text }));
  }
  appendText(messages, text) {
    messages.push(this.userMsg(text));
  }
  async chat(system, tools, messages, opts = {}) {
    const r = await post(
      `${this.base}/chat/completions`,
      { authorization: `Bearer ${this.key}` },
      { model: this.model, messages: [{ role: "system", content: system }, ...messages], tools, max_completion_tokens: this.maxTokens },
      { timeoutMs: opts.timeoutMs ?? 300_000 },
    );
    const m = r.choices[0].message;
    const u = r.usage ?? {};
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    const toolCalls = (m.tool_calls ?? []).map((tc) => {
      let args;
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = { _unparseable: tc.function.arguments };
      }
      return { id: tc.id, name: tc.function.name, args };
    });
    const am = { role: "assistant", content: m.content ?? "" };
    if (m.tool_calls) am.tool_calls = m.tool_calls;
    return {
      text: m.content ?? "",
      toolCalls,
      stop: r.choices[0].finish_reason,
      usage: { input: (u.prompt_tokens ?? 0) - cached, output: u.completion_tokens ?? 0, cacheRead: cached, cacheWrite: 0 },
      assistant: [am],
    };
  }
}

function requireKey(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing API key: set ${name} (or BAB_EVAL_API_KEY_ENV to the variable that holds it).`);
  return v;
}

export function makeProvider(cfg) {
  if (cfg.provider === "anthropic") return new Anthropic(cfg);
  if (cfg.provider === "openai") return new OpenAICompat(cfg);
  throw new Error(`Unknown provider ${cfg.provider} (use anthropic or openai)`);
}

/** price: USD per 1M tokens { input, output, cacheRead, cacheWrite }. */
export function costUsd(usage, price) {
  if (!price) return 0;
  return (
    (usage.input * (price.input ?? 0) +
      usage.output * (price.output ?? 0) +
      usage.cacheRead * (price.cacheRead ?? price.input ?? 0) +
      usage.cacheWrite * (price.cacheWrite ?? price.input ?? 0)) /
    1e6
  );
}
