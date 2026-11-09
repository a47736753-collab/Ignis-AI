-- IGNIS AI migration 001: CSV dataset upload + forecast run persistence.
-- Safe to run more than once (idempotent). Run in the Supabase SQL Editor or psql.
--
-- SECURITY MODEL
--   * The Node server connects with a direct PostgreSQL login. That connection bypasses Row
--     Level Security, so server/db.js filters EVERY dataset query by user_id. Do not remove those filters.
--   * The RLS policies below are defence in depth for any access through Supabase's REST API
--     (PostgREST) with the public anon key: authenticated users can only touch their own rows,
--     and anonymous users get nothing.

CREATE TABLE IF NOT EXISTS datasets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT NOT NULL,                       -- Supabase auth.users.id (as text)
  name              TEXT NOT NULL,
  source_label      TEXT NOT NULL DEFAULT 'user-uploaded',
  original_filename TEXT,
  row_count         INT  NOT NULL CHECK (row_count BETWEEN 1 AND 5000),
  date_start        DATE NOT NULL,
  date_end          DATE NOT NULL,
  content_sha256    TEXT NOT NULL,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dataset_observations (
  id            BIGSERIAL PRIMARY KEY,
  dataset_id    UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  zone_id       TEXT NOT NULL,
  obs_date      DATE NOT NULL,
  temp_c        DOUBLE PRECISION NOT NULL CHECK (temp_c BETWEEN -30 AND 60),
  humidity_pct  DOUBLE PRECISION NOT NULL CHECK (humidity_pct BETWEEN 0 AND 100),
  wind_kmh      DOUBLE PRECISION NOT NULL CHECK (wind_kmh BETWEEN 0 AND 200),
  ndvi          DOUBLE PRECISION NOT NULL CHECK (ndvi BETWEEN -1 AND 1),
  fire_history  DOUBLE PRECISION NOT NULL CHECK (fire_history BETWEEN 0 AND 1),
  UNIQUE (dataset_id, zone_id, obs_date)
);

CREATE TABLE IF NOT EXISTS forecast_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id      UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  engine_version  TEXT NOT NULL,
  weights         JSONB NOT NULL,
  thresholds      JSONB NOT NULL,
  high_zone_count INT NOT NULL,
  day_count       INT NOT NULL,
  run_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forecast_run_outputs (
  id            BIGSERIAL PRIMARY KEY,
  run_id        UUID NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
  zone_id       TEXT NOT NULL,
  target_date   DATE NOT NULL,
  score         INT  NOT NULL CHECK (score BETWEEN 0 AND 100),
  severity      TEXT NOT NULL CHECK (severity IN ('low','med','high')),
  contributions JSONB,
  UNIQUE (run_id, zone_id, target_date)
);

CREATE INDEX IF NOT EXISTS datasets_user_uploaded_idx ON datasets (user_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS forecast_runs_dataset_idx ON forecast_runs (dataset_id, run_at DESC);

ALTER TABLE datasets              ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataset_observations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_runs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_run_outputs  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Read own datasets"   ON datasets;
DROP POLICY IF EXISTS "Insert own datasets" ON datasets;
DROP POLICY IF EXISTS "Delete own datasets" ON datasets;
CREATE POLICY "Read own datasets"   ON datasets FOR SELECT TO authenticated USING (user_id = auth.uid()::text);
CREATE POLICY "Insert own datasets" ON datasets FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid()::text);
CREATE POLICY "Delete own datasets" ON datasets FOR DELETE TO authenticated USING (user_id = auth.uid()::text);

DROP POLICY IF EXISTS "Read own dataset observations"   ON dataset_observations;
DROP POLICY IF EXISTS "Insert own dataset observations" ON dataset_observations;
CREATE POLICY "Read own dataset observations" ON dataset_observations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM datasets d WHERE d.id = dataset_id AND d.user_id = auth.uid()::text));
CREATE POLICY "Insert own dataset observations" ON dataset_observations FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM datasets d WHERE d.id = dataset_id AND d.user_id = auth.uid()::text));

DROP POLICY IF EXISTS "Read own forecast runs"   ON forecast_runs;
DROP POLICY IF EXISTS "Insert own forecast runs" ON forecast_runs;
CREATE POLICY "Read own forecast runs"   ON forecast_runs FOR SELECT TO authenticated USING (user_id = auth.uid()::text);
CREATE POLICY "Insert own forecast runs" ON forecast_runs FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid()::text AND EXISTS (SELECT 1 FROM datasets d WHERE d.id = dataset_id AND d.user_id = auth.uid()::text));

DROP POLICY IF EXISTS "Read own forecast outputs"   ON forecast_run_outputs;
DROP POLICY IF EXISTS "Insert own forecast outputs" ON forecast_run_outputs;
CREATE POLICY "Read own forecast outputs" ON forecast_run_outputs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM forecast_runs r WHERE r.id = run_id AND r.user_id = auth.uid()::text));
CREATE POLICY "Insert own forecast outputs" ON forecast_run_outputs FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM forecast_runs r WHERE r.id = run_id AND r.user_id = auth.uid()::text));
