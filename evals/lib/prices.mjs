// List prices in USD per 1M tokens, copied from the providers' public pricing pages.
// Check them before quoting costs; override with BAB_EVAL_PRICE="input,output,cacheRead,cacheWrite".
export const PRICES_CHECKED = "2026-10-19";
export const PRICES = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, // prompts <= 100k tokens
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export function priceFor(model, env = process.env) {
  if (env.BAB_EVAL_PRICE) {
    const [input, output, cacheRead, cacheWrite] = env.BAB_EVAL_PRICE.split(",").map(Number);
    return { input, output, cacheRead, cacheWrite };
  }
  return PRICES[model] ?? null;
}
