# Change log: IGNIS AI readiness upgrade

Base: the project you uploaded (`Ignis-AI-main.zip`, SHA-256 `e2365d76b2dd8eb180c8f73e6b0498f6275a91357c66f51f91dbd2036b219dcc`).
Nothing was removed. The hero, theme, map, dashboard layout, navigation and the scoring formula are unchanged.

## What changed

**Stage 1: CSV upload and forecast ingestion**
- The scoring formula moved, unchanged, into `public/scoring.js` (shared by browser and server). Regression tests prove identical output to the original.
- Dashboard "Upload CSV data" panel: drag and drop, browse, size/type checks, progress, validation errors with line numbers, preview, confirm, templates.
- Server-side validation and scoring (`server/csv.js`); uploaded values replace the demo forecast completely (no mixing, no demo offsets). Forecast window follows the uploaded dates (1-7 days).
- Persistence for signed-in users (`datasets`, `dataset_observations`, `forecast_runs`, `forecast_run_outputs`); guests get session-only use. Per-user isolation enforced in SQL.
- Active data source is always labelled (data bar, map badge, zone panel, methodology header, Groq context).

**Stage 2: credibility**
- Hero figures: text is in the HTML (no count-up from 0). The "$140B+" card is replaced by the sourced "$135-150B" AccuWeather preliminary estimate with a caveat; all three are labelled as outside figures; IGNIS AI's own impact is labelled "Not yet validated".
- All "trained machine-learning model" wording removed (page, tour, AI prompts). New "How the risk score is calculated" section generated from the engine's constants, a Groq-role explanation with live status, a five-way data-kind legend, and limitations.
- Data sources section states that none is connected live yet.

**Stage 3: authentication and persistence**
- Hero "Sign in / Get started" opens a dedicated full-screen sign-in step. Password show/hide, inline validation, loading state, friendly errors, success feedback, Escape to close, sign-out feedback, explicit session persistence.
- Honest demo-mode labelling when Supabase is not configured. Signed-in state is cleared on sign-out/user change.
- Security audit: `docs/SECURITY_AUDIT.md`.

**Stage 4: evidence and impact**
- Metrics module verified against scikit-learn. Average Precision and trapezoidal PR-AUC are shown separately; ROC-AUC, precision, recall, F1 and the confusion matrix appear only for real data with enough labels. Synthetic samples show "Not yet validated".
- Backtest replay labelled synthetic vs verified (a source is required), reveals only past days, plus a no-leakage case-study workflow.
- Impact tab: potential operational benefit with stated assumptions and a preparedness explanation; fixed an `Infinity` display when no zone is flagged. Limitations expanded.
- `validation.json` / `backtest.json` are validated server-side before being shown.

## Files

Modified:
```
.env.example
data/README.txt
db/schema.sql
package.json
public/index.html
server.js
server/db.js
server/groq.js
.gitignore
README.md
```
New:
```
db/migrations/001_csv_datasets.sql
public/metrics.js
public/scoring.js
server/csv.js
tests/api.datasets.test.js
tests/db.postgres-queries.test.js
tests/e2e/e2e_lib.py
tests/e2e/mock-groq.js
tests/e2e/mock-supabase.js
tests/e2e/run_e2e.py
tests/e2e/run_e2e_ui.py
tests/e2e/supabase-stub.js
tests/evidence.api.test.js
tests/fixtures/metrics-reference.json
tests/fixtures/original-index.html
tests/helpers.js
tests/metrics.test.js
tests/run-all.js
tests/scoring.regression.test.js
docs/CHANGES.md
docs/CSV_FORMAT.md
docs/SECURITY_AUDIT.md
docs/TESTING.md
```
No new runtime dependencies (`package-lock.json` unchanged).

## Rollback

- Code: your original zip is the baseline. With git: `git revert <merge-commit>` (or redeploy the previous Vercel deployment, below).
- Database: the migration is additive and does not touch existing tables. To remove it (this deletes uploaded datasets):
  `DROP TABLE forecast_run_outputs, forecast_runs, dataset_observations, datasets CASCADE;`

## Updating GitHub and redeploying

Repository: https://github.com/a47736753-collab/Ignis-AI.git (nothing here pushes or deploys for you).

1. **Run the database migration first** (Supabase SQL Editor): `db/migrations/001_csv_datasets.sql`. The old code keeps working with the new tables present.
2. Get the repo and a branch:
   ```
   git clone https://github.com/a47736753-collab/Ignis-AI.git   # or use your existing clone
   cd Ignis-AI
   git checkout -b upgrade/csv-forecast
   ```
3. Unzip the upgraded project and copy the **contents** of its `Ignis-AI-main/` folder over the clone (same layout; overwrite when asked). Do not copy `.git` or any `.env`.
4. Check before committing: `git status` (confirm `.env` is **not** listed) and `git diff --stat`. Then:
   ```
   npm test
   git add -A
   git commit -m "CSV forecast upload, methodology, evidence and auth upgrades"
   git push -u origin upgrade/csv-forecast
   ```
5. **Vercel:** in the existing project, Settings > Environment Variables, make sure these exist for Production and Preview (values from your `.env`, never committed): `GROQ_API_KEY`, `GROQ_MODEL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DATABASE_URL`, `DATABASE_SSL`. Optional: `CSV_MAX_BYTES`, `CSV_MAX_ROWS`, `UPLOAD_RATE_LIMIT`. Do not change other project settings.
6. Pushing the branch normally creates a **Preview deployment**. Test there first: guest upload, sign-in, saved dataset, second user cannot see it, AI explanation, Evidence tab.
7. When happy, merge the branch into `main` (pull request) so the existing Production deployment updates. To roll back, open Vercel > Deployments, pick the previous deployment and "Promote to Production" (or `git revert`).

If the Preview or Production build fails, the first things to check are the environment variables and that the migration ran. I could not run a Vercel build, so treat this as untested until your preview works.
