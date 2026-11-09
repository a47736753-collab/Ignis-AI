# IGNIS AI

Forest fire risk predictor with early warning. IGC Hackathon 2026 prototype.

**What it is.** IGNIS AI scores every zone of a forest region for each day of a forecast window and helps a fire
station act on it: plan resources, stage trucks, warn villages, and test the plan against a simulated fire.

**How scores are made (read this first).** Every risk score comes from a **deterministic weighted formula** with
expert-set weights (temperature 24%, dry air 26%, wind 12%, dry vegetation 22%, fire history 16%). It is **not** a
trained machine-learning model, and it has **not** been validated against real fire outcomes yet. Groq (a language
model) only *explains* scores; it never sets or changes one. The website's "How the risk score is calculated"
section shows the exact formula, generated from the same code that does the scoring.

**What data it runs on.** By default the site shows synthetic demonstration data. You can upload your own
observations as a CSV (see [docs/CSV_FORMAT.md](docs/CSV_FORMAT.md)); the forecast then uses only your data. The
active data source is always labelled in the dashboard.

## Run it

1. Install Node.js 18 or newer from https://nodejs.org
2. Copy `.env.example` to `.env` and fill in what you have (everything is optional; see below).
3. Start the server:

   ```
   npm start
   ```

4. Open http://localhost:3000

There is nothing to install for the basic site. `npm install` is only needed if you connect PostgreSQL (it installs `pg`).

## Environment variables

Defined in `.env.example` (placeholders only). Never commit `.env`.

| Variable | Needed for | Notes |
|---|---|---|
| `PORT` | always | default 3000 |
| `GROQ_API_KEY`, `GROQ_MODEL` | AI explanations, briefings, assistant | server-side only. Without it the AI panels show an error message and everything else works |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | sign-in | the project URL and the public anon/publishable key. **Never use the service_role key** |
| `DATABASE_URL`, `DATABASE_SSL` | saving alerts, briefings, datasets | without it the server uses in-memory storage (lost on restart) |
| `CSV_MAX_BYTES`, `CSV_MAX_ROWS`, `UPLOAD_RATE_LIMIT` | optional | CSV limits, defaults 200 KB / 500 rows / 30 per minute per IP |
| `IGNIS_DATA_DIR` | optional | folder with `validation.json` / `backtest.json` (default `./data`) |

## Database setup and migration

Pick one. The site works with none of them.

**A. No database.** Uploaded datasets are used for the current session only. Evidence files can still be added to `data/`.

**B. PostgreSQL / Supabase.**
1. Set `DATABASE_URL` (and `DATABASE_SSL=true` if your host needs it) in `.env`.
2. **New database:** run `db/schema.sql` once (Supabase SQL Editor or `psql`).
   **Existing database** (you already ran the old `schema.sql`): run only `db/migrations/001_csv_datasets.sql`.
   Both are idempotent, so running them twice is safe. They need PostgreSQL 13+.
3. `npm install`, then `npm start`. The terminal prints "PostgreSQL connected".

The new tables are `datasets`, `dataset_observations`, `forecast_runs` and `forecast_run_outputs`.

> **Important:** the server connects with a direct PostgreSQL login, which bypasses Supabase Row Level Security.
> User separation is therefore enforced in the server's SQL (`WHERE user_id = ...`). The RLS policies are a second
> layer for anyone reaching the tables through Supabase's REST API. See [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md).

## Add your Groq API key

1. Create a key at https://console.groq.com/keys
2. Put it after `GROQ_API_KEY=` in `.env` (no quotes, no spaces) and restart.

The key stays on the server. In the dashboard, click a zone and press **Explain with AI**. The server validates
everything it forwards, and every request tells Groq whether the numbers are demonstration or uploaded data.
`GROQ_MODEL` defaults to `llama-3.3-70b-versatile`.

## Using the CSV upload

Dashboard > **Upload CSV data**. Download the blank template (the measurement cells are empty on purpose) or the
example with *synthetic* demo values to test the pipeline. One row per zone per date, all 24 zones for every date,
1 to 7 consecutive dates. Full rules, units and ranges: [docs/CSV_FORMAT.md](docs/CSV_FORMAT.md).

Signed-in users' datasets are saved to their account and listed under "Your saved datasets"; guests can use an
upload for the session only. Use **Use demo data** to return to the demonstration forecast at any time.

## Evidence section

With no files in `data/`, the Evidence section shows labelled synthetic samples and **"Not yet validated"**.
Add `data/validation.json` / `data/backtest.json` (format in `data/README.txt`) to show real results. Metrics are
withheld unless there are at least 30 labelled zone-days with 5 fires and 5 non-fires. Average Precision and the
trapezoidal PR-AUC are reported separately because they are different numbers.

## Tests

```
npm test            # 67 Node tests: scoring regression, CSV/API, evidence files, metrics, DB query shape
npm run test:e2e    # browser tests (needs: pip install playwright numpy scikit-learn && playwright install chromium)
```
What is and is not covered: [docs/TESTING.md](docs/TESTING.md).

## Files

```
server.js                  web server and API routes
server/csv.js              CSV parsing, validation and forecast generation (server-side, authoritative)
server/groq.js             Groq calls and input checks
server/db.js               database layer (PostgreSQL or in-memory)
server/env.js              .env loader
public/index.html          the website
public/scoring.js          THE scoring formula (shared by browser and server)
public/metrics.js          ROC-AUC / Average Precision / PR-AUC / precision / recall / F1
data/                      optional evidence JSON files
db/schema.sql              full PostgreSQL schema (fresh install)
db/migrations/             incremental migrations for existing databases
docs/                      CSV format, security audit, testing notes, change log
tests/                     automated tests
```

## API routes

| Route | What it does |
|---|---|
| `GET /api/config` | capabilities and public config (no secrets) |
| `GET /api/datasets/schema` | CSV columns, ranges, zone ids, limits and the engine's weights/thresholds |
| `POST /api/datasets/validate` | validates a CSV (no saving). Returns line-numbered errors or a preview |
| `POST /api/datasets` | validates, scores with the engine and, if a valid sign-in token is sent, saves. Without a token the result is session-only |
| `GET /api/datasets` | lists the signed-in user's datasets |
| `GET /api/datasets/:id` / `DELETE` | opens / deletes one of the user's own datasets (404 for anyone else's) |
| `POST /api/ai-explain`, `/api/ai-briefing`, `/api/ai-chat` | Groq explanations, briefings, assistant (grounded in the forecast sent) |
| `POST/GET /api/alerts`, `POST /api/alerts/ack` | alerts for the signed-in user |
| `POST/GET /api/briefings`, `POST/GET /api/actions` | briefings and officer actions for the signed-in user |
| `GET /api/validation`, `GET /api/backtest` | validated contents of the evidence files, if present |

Saved-record routes need a valid Supabase session; the server verifies the bearer token and takes the user id
from the verified identity, never from the request body.

## Deploying (GitHub + Vercel)

See "Updating GitHub and redeploying" in [docs/CHANGES.md](docs/CHANGES.md). In short: run the migration in
Supabase first, push to GitHub (preferably on a branch to get a Vercel preview), check the preview, then merge.
This project is a long-running Node server (`npm start`); the original README targeted hosts such as Render or
Railway. Keep whatever Vercel project settings already work for you. Note that serverless hosting resets in-memory
storage and rate-limit counters between instances, so use `DATABASE_URL` for anything you want to keep.

## Known limitations

- Scores are demonstration/uploaded-data scores from an untested, expert-weighted formula. No accuracy claim is made.
- The 24-zone grid and the map are illustrative; uploaded rows attach to zone ids A1 to D6.
- NASA FIRMS, Sentinel-2, Open-Meteo and ERA5 are the intended sources; none is connected live yet.
- Alerts, dispatch and village messages are simulated.
- Uploaded data is validated for format and range, not for truthfulness.
