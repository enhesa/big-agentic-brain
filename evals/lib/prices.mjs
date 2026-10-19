// List prices in USD per 1M tokens, copied from the providers' public pricing pages.
// Check them before quoting costs; override with BAB_EVAL_PRICE="input,output,cacheRead,cacheWrite".
export const PRICES_CHECKED = "2026-10-19";
export const PRICES = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, // prompts <= 100k tokens
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

function assertPrice(p, label) {
  if (!p) return null;
  for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (!Number.isFinite(p[k]) || p[k] < 0) {
      throw new Error(`Invalid price for ${label}: ${k}=${p[k]} (need four non-negative numbers)`);
    }
  }
  return p;
}

export function priceFor(model, env = process.env) {
  if (env.BAB_EVAL_PRICE) {
    const parts = env.BAB_EVAL_PRICE.split(",").map(Number);
    if (parts.length !== 4) throw new Error(`BAB_EVAL_PRICE must be "in,out,cacheRead,cacheWrite" (got ${env.BAB_EVAL_PRICE})`);
    const [input, output, cacheRead, cacheWrite] = parts;
    return assertPrice({ input, output, cacheRead, cacheWrite }, "BAB_EVAL_PRICE");
  }
  return assertPrice(PRICES[model] ?? null, model);
}
