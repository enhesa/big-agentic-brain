# Distractor generators

`gen_distractors.mjs` rebuilds `../distractors-synthetic.json` (needs `ANTHROPIC_API_KEY`, ~$1 Haiku).
`distractors-templated.json` is produced by the same research tree (`gaps/gen_tk.py` / templated expander).

The committed JSON files are marked `linguist-generated` in `.gitattributes` so they do not dominate PR diffs.
