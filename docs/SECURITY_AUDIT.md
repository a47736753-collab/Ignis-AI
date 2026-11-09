# Security and data-access audit

Scope: the code in this repository (server.js, server/*.js, db/schema.sql, db/migrations, public/index.html).
Method: code review plus the automated tests listed at the end. **Not covered:** your live Supabase project, live
Vercel configuration and live database; those need the manual checks in the last section.

## Summary of findings

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | The server uses a direct PostgreSQL connection, which **bypasses Row Level Security**. Per-user privacy depends on `WHERE user_id = ...` in every query | High (by design, must be preserved) | Verified for all existing user tables (alerts, briefings, incident_actions) and built into every new dataset query. Covered by tests. **Do not remove those filters** |
| 2 | New dataset tables had no protection layer beyond the server code | Medium | Fixed: RLS enabled with owner-only policies for the REST API path (`db/migrations/001_csv_datasets.sql`), plus server-side scoping |
| 3 | Fake sign-in when Supabase is not configured: the browser accepted any email/password and showed a signed-in user | Medium (misleading, not exploitable) | The fake user cannot call any user-scoped route (the server requires a real Supabase token; tested). The screen now says "Demo mode: this is not real authentication" and uploads are shown as session-only |
| 4 | `/api/config` returns `SUPABASE_ANON_KEY` to every visitor | Low (intended) | The anon/publishable key is meant to be public. **Never put the service_role key in `SUPABASE_ANON_KEY`**; the `.env.example` says so |
| 5 | CSV upload is a new untrusted-input surface | Medium | Server-side validation; 200 KB / 500 row limits; JSON body cap; 25 datasets per user; rate limit; parameterised SQL (`unnest` arrays); transaction with rollback; text echoed in the UI is HTML-escaped; dataset names are reduced to `A-Za-z0-9 ._()-` |
| 6 | Prompt-injection route via dataset name into Groq | Low | Name is sanitised, length-capped and passed only as a labelled field; prompts say never to invent data |
| 7 | Rate limiter keys on the socket address. Behind a proxy or on serverless, users may share a bucket, and counters reset per instance | Low | Not changed. Consider a trusted-proxy `X-Forwarded-For` or an edge rate limit |
| 8 | Alerts/acknowledgements are keyed by zone+day, not by dataset, so alerts from different datasets look alike | Low (data-model limitation) | Documented. Not changed to avoid altering the existing alert schema |
| 9 | `zones`, `observations`, `forecasts`, `model_runs` have **public read** policies | Informational | They hold no user data and the app does not use them. Keep private data out of them |
| 10 | Evidence JSON files could show unvalidated results | Medium (credibility) | Files are validated; labels must be 0/1, scores 0-100; tiny files withheld; "verified" needs a named source |
| 11 | In-memory fallback loses data on restart | Informational | Documented; capped sizes |
| 12 | No `vercel.json` / unknown deployment shape | Informational | See "Manual checks" |

## How user separation is enforced for datasets

- Every route that reads or deletes a dataset first calls `requireUser`, which verifies the bearer token with Supabase
  (`/auth/v1/user`) and takes the user id from that response, never from the request.
- `db.listDatasets/getDataset/deleteDataset` all filter by `user_id = $n`; child tables (observations, run outputs) are
  reached only through a JOIN to the owner's rows.
- A dataset that belongs to someone else returns **404**, the same answer as "does not exist", so ids cannot be probed.
- Dataset ids must be UUIDs; anything else is a 404 before reaching the database.
- A request that carries an `Authorization` header that fails verification gets **401** (it is never silently treated as a guest).
- The browser clears the signed-in user's saved list and closes a saved dataset on sign-out or user change.

## Tests backing these claims

- `tests/api.datasets.test.js`: user B cannot list, read or delete user A's dataset over HTTP (mock Supabase); anonymous gets 401;
  invalid ids get 404; bad tokens get 401; per-user cap; rate limit.
- `tests/db.postgres-queries.test.js`: with a recording fake `pg` pool, every dataset query has matching placeholders, is
  parameterised (a user id like `x'; DROP TABLE datasets; --` is only ever a bound parameter), is user-scoped, and the save is one
  transaction that rolls back on error. **This does not prove the SQL runs on a real database.**
- `tests/e2e/run_e2e.py`: in a real browser, user B does not see user A's dataset and switching users closes it.

## Manual checks you should do (I could not)

1. **RLS in your Supabase project.** After running the migration, in the SQL editor:
   ```sql
   begin;
   set local role authenticated;
   select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
   select count(*) from datasets;            -- must count only rows owned by that user id
   rollback;
   begin; set local role anon; select count(*) from datasets; rollback;   -- must be 0 (or permission denied)
   ```
2. Confirm which role `DATABASE_URL` uses. The default `postgres` role bypasses RLS. A least-privilege role limited to
   the app's tables is safer.
3. Confirm Supabase "Confirm email" and password rules match what you want (the app only enforces 8+ characters on sign-up in the UI).
4. Confirm the production `SUPABASE_ANON_KEY` is the anon/publishable key, not a service key.
5. Check how the app is hosted on Vercel (see docs/CHANGES.md) and that environment variables are set for Production and Preview.
