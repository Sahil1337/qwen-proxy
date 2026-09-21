# @meetai/evals-retrieval

Measures retrieval instead of eyeballing it: index a set of extracted claims,
run a golden query set, print `hit@1`, `hit@3`, `recall@k`, `MRR`, and the
out-of-domain rejection rate.

```bash
GEMINI_API_KEY=... bun run eval:retrieval
```

The index is cached at `EVAL_STORE` (default `out/index.json`), so re-runs cost
no embedding calls. Set `EVAL_REINDEX=1` after changing the claims or the model.
See `src/env.ts` for the full set of variables.

## Why out-of-domain queries are in the golden set

A retriever that always returns its nearest record scores perfectly on
in-domain questions, because every one of them has an answer. The
`out-of-domain` queries pass only when *nothing* clears `EVAL_MIN_SCORE` — they
are what stops a good-looking score from hiding a system that answers
everything, confidently, whether it knows or not.

## Fixtures

- `fixtures/claims.json` — 44 propositions from the kickoff transcript. Same
  shape as `evals/propositions`' `out/latest/claims.json`, so that eval's output
  feeds this one: extraction quality and retrieval quality over the same claims.
- `fixtures/golden-queries.json` — 17 queries across `semantic`, `ownership`,
  `deadline`, `risk`, and `out-of-domain`. `expect` holds case-insensitive
  substrings rather than proposition ids, so the set survives re-extraction
  changing the ids.
