// Minimal MCP Streamable-HTTP client for BAB's /mcp endpoint (JSON-RPC over POST).
export class McpClient {
  constructor(origin, email, name) {
    this.url = `${origin.replace(/\/$/, "")}/mcp`;
    this.headers = { "x-bab-actor-email": email, "x-bab-actor-name": name };
    this.sessionId = null;
    this.nextId = 0;
  }

  async init() {
    const r = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bab-evals", version: "1" },
    });
    this.instructions = r?.result?.instructions ?? "";
    await this.rpc("notifications/initialized", undefined, true);
    return this;
  }

  async rpc(method, params, notify = false) {
    const body = { jsonrpc: "2.0", method };
    if (!notify) body.id = ++this.nextId;
    if (params !== undefined) body.params = params;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    this.sessionId = res.headers.get("mcp-session-id") ?? this.sessionId;
    const text = await res.text();
    if (!res.ok) return { error: { code: res.status, message: text.slice(0, 500) } };
    if (!text.trim()) return {};
    const t = text.trimStart();
    if (t.startsWith("event:") || t.startsWith("data:")) {
      const data = t.split("\n").filter((l) => l.startsWith("data:")).at(-1);
      return JSON.parse(data.slice(5));
    }
    return JSON.parse(text);
  }

  async listTools() {
    return (await this.rpc("tools/list", {}))?.result?.tools ?? [];
  }

  /** Returns { text, isError }. */
  async call(name, args) {
    const r = await this.rpc("tools/call", { name, arguments: args });
    if (r.result) {
      return { text: (r.result.content ?? []).map((c) => c.text ?? "").join(""), isError: Boolean(r.result.isError) };
    }
    return { text: JSON.stringify(r.error ?? r).slice(0, 2000), isError: true };
  }
}
