# Testing

## What was run

| Suite | Command | What it proves |
|---|---|---|
| `scoring.regression.test.js` | `npm test` | The shared scoring module returns **identical** scores, contributions and normalised values to the original code extracted from the original `index.html` (100,000+ grid inputs, 50,000 random inputs, all 168 original demo zone-days); weights and thresholds unchanged |
| `api.datasets.test.js` | `npm test` | CSV validation (16 malformed-file cases, line numbers, error cap, size/row limits, date gaps), guest vs signed-in upload, uploaded values drive scores, round-trip of the demo forecast through CSV, per-user isolation over HTTP with a mock Supabase, 401/404/409/429 behaviour, existing alert/briefing routes |
| `evidence.api.test.js` | `npm test` | Evidence files are validated and sanitised; malformed files are rejected |
| `metrics.test.js` | `npm test` | ROC-AUC, Average Precision, trapezoidal PR-AUC, precision, recall, F1 and the confusion matrix match **scikit-learn** on 13 reference cases (`tests/fixtures/metrics-reference.json`, generated with scikit-learn 1.9.1); thin data is refused |
| `db.postgres-queries.test.js` | `npm test` | PostgreSQL code path shape with a fake pool (see limits below) |
| `e2e/run_e2e.py` | `npm run test:e2e` | Real Chromium: upload panel, templates, rejected files, guest upload drives map/alerts/timeline, Groq receives the uploaded context and a no-ML prompt, AI failure message, dataset replacement, demo restore, signed-in save/list/open/delete, user isolation, sign-out, no JS errors, no sideways scroll on a 390 px phone |
| `e2e/run_e2e_ui.py` | `npm run test:e2e` | Hero figures never show 0; methodology numbers match the engine; no ML claims remain; evidence withholds synthetic and thin data and matches scikit-learn on a fixture; verified-source labelling; replay shows only past days; Impact has no Infinity/NaN on zero alerts; the whole sign-in flow (validation, spinner, errors, success, refresh persistence, sign-out, Escape, demo mode) |

The browser suites use a Supabase client **stub** and mock Supabase/Groq servers, and small synthetic fixtures for evidence.
Those fixtures are test data only and are never shipped in `data/`.

## What was NOT tested

- **A real PostgreSQL database.** No Postgres server was available. The SQL in `server/db.js` and the migration has not been
  executed anywhere. Run the migration and the tests under "First run on your database" below.
- **Real Supabase** sign-in (email, Google OAuth, email confirmation) and real session persistence in supabase-js.
- **Live Groq calls.** Only a local fake was used; the real model's answers were not evaluated.
- **Vercel deployment.** Not run. No `vercel.json` exists in the project, so the build/runtime shape is unknown to me.
- Browsers other than Chromium; real phones (only a 390 px viewport was checked); accessibility audit; load/performance tests.
- Real-world accuracy of the scores. No validation against real fires has been done.

## First run on your database (suggested)

1. Run the migration, set `DATABASE_URL`, start the server.
2. Sign in, upload `ignis-ai-example-SYNTHETIC-demo-values.csv`, confirm it is listed under "Your saved datasets".
3. Sign in as a second user and confirm the first user's dataset is not visible.
4. Run the RLS queries in docs/SECURITY_AUDIT.md.

## Running

```
npm test                                  # Node tests, no dependencies
pip install playwright numpy scikit-learn && playwright install chromium
npm run test:e2e                          # browser tests
```
