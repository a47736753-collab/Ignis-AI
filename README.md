# IGNIS AI

Forest fire risk predictor with early warning. IGC Hackathon 2026 prototype.

The website runs on illustrative demo data. A simple scoring function stands in for the trained model until you connect it.

## Run it

1. Install Node.js 18 or newer from https://nodejs.org
2. Open a terminal in this folder.
3. Open the file `.env` in a text editor and add your Groq key (see below).
4. Start the server:

   ```
   npm start
   ```

5. Open http://localhost:3000

There is nothing to install for the basic site. `npm install` is only needed if you connect PostgreSQL.

## Add your Groq API key

1. Create a key at https://console.groq.com/keys
2. Open `.env` and paste it after `GROQ_API_KEY=`, with no quotes and no spaces.
3. Restart the server.

The key stays on the server. The browser never sees it. In the dashboard, click a zone and press **Explain with AI**.

The AI only explains numbers the risk model already produced. It cannot change a score. The server checks every value it receives and only sends numbers, not free text, to Groq.

`GROQ_MODEL` defaults to `llama-3.3-70b-versatile`. Groq changes its model list over time. To see what your account can use:

```
curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer YOUR_KEY"
```

## Add your database

Pick one. The site works with none of them.

**A. No database: JSON files (easiest).** Put `validation.json` and `backtest.json` in `data/`. The Evidence section then shows your real model results. See `data/README.txt` for the format.

**B. PostgreSQL (Supabase, Neon, Render, local).**
1. Set `DATABASE_URL` in `.env`. Set `DATABASE_SSL=true` if your host needs SSL.
2. Run `db/schema.sql` on your database. Re-run it after upgrading to apply new ownership columns and RLS policies; legacy records without an owner will no longer appear in user-scoped API responses.
3. Run `npm install`, then `npm start`.
The terminal prints "PostgreSQL connected". Each authenticated forecast run then saves its alerts to the `alerts` table.

**C. Another database (Firestore, MySQL, MongoDB...).** Open `server/db.js` and fill in four functions: `saveAlerts`, `listAlerts`, `getValidation`, `getBacktest`. Keep the return shapes and nothing else changes.

## Connect your trained model

Today the zone scores come from a demo function in `public/index.html` (the `scoreFrom` function in the data script). To use your own model, have it write a score from 0 to 100 per zone per day, then replace that function or serve scores from a new route in `server.js`.

## Files

```
server.js            web server and API routes
server/groq.js       secure Groq call and input checks
server/db.js         database layer (the one place to plug in yours)
server/env.js        .env loader
public/index.html    the whole website
data/                optional JSON results
db/schema.sql        starter PostgreSQL tables
.env                 your keys (never share or commit this file)
.env.example         the same file with no secrets, safe to share
```

## API routes

| Route | What it does |
|---|---|
| `GET /api/config` | Returns capabilities (`groq`, `db`, `supabaseUrl`, `supabaseAnonKey`) without exposing secrets |
| `POST /api/ai-explain` | Validates a zone result and returns grounded risk factor explanation |
| `POST /api/ai-briefing` | Generates a structured operational executive briefing for current high-risk zones |
| `POST /api/ai-chat` | Interactive Q&A grounded strictly in current forecast, alerts and staging |
| `POST /api/alerts` | Saves alerts from a forecast run |
| `GET /api/alerts` | Lists saved alerts |
| `POST /api/alerts/ack` | Acknowledges an alert with timestamp and verified officer identity |
| `POST /api/briefings` | Saves an executive operational briefing to persistent storage |
| `GET /api/briefings` | Lists saved operational briefings |
| `POST /api/actions` | Logs an officer action (e.g. SOP checklist step completed) |
| `GET /api/actions` | Lists logged incident actions |
| `GET /api/validation` | Returns `data/validation.json` if present |
| `GET /api/backtest` | Returns `data/backtest.json` if present |

Saved-record routes (`/api/alerts`, `/api/alerts/ack`, `/api/briefings`, and `/api/actions`) require a valid Supabase Auth session. The server verifies the bearer token and derives record ownership from that verified identity; guest/demo mode does not persist records to these routes.

## Hackathon Features Added

1. **Ask IGNIS AI Assistant**: Tactical Groq-powered copilot grounded strictly in active forecast data, alert counts, and staged tanker units.
2. **AI Executive Briefing Generator**: Generates formatted incident commander briefings with key meteorological drivers, staging recommendations, copy-to-clipboard, export to text file, and Supabase cloud saving.
3. **Supabase Authentication & RLS**: Email/Password and Google OAuth sign-in, user-scoped persistence, and guest/demo fallback when credentials are not configured.
4. **Supabase PostgreSQL Persistence**: Tables for alerts, acknowledgments, operational briefings, and incident action checklist logs.
5. **5-Signal Risk Attribution**: Real mathematical percentage contributions (`temp`, `hum`, `wind`, `ndvi`, `hist`), regional baseline differential comparisons, acute atmospheric hazard tags, and tactical suppression difficulty cards.
6. **Station SOP Checklists**: Interactive 4-step officer verification checklist per alert with Human-in-the-Loop safety protocol.
7. **Dual ROC & Precision-Recall Curves**: Toggle between ROC-AUC and PR-AUC with baseline prevalence reference, addressing heavy class imbalance in wildfire detection. Observational vs synthetic benchmarks clearly labeled.

## Deploying

This is a normal Node server. Render, Railway and Fly.io can run it with `npm start`. Set the same values from `.env` as environment variables on the host. Do not upload `.env` to GitHub.

## Limitations

Alerts, dispatch and village messages are simulated. Zones, weather values and scores are demonstration data until you connect real feeds and your trained model.
