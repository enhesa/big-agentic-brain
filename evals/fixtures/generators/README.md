# Distractor generators

- `gen_distractors.mjs` rebuilds `../distractors-synthetic.json` (needs `ANTHROPIC_API_KEY`, about $1 Haiku).
- `gen_distractors_templated.mjs` rebuilds `../distractors-templated.json` deterministically (no LLM).

The committed JSON files are **frozen artifacts** (also marked `linguist-generated` in `.gitattributes`). Re-run a generator only when intentionally refreshing the corpus.
