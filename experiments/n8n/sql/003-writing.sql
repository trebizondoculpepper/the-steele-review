-- One bounded writing step for the n8n track (#916), in the experiment's own database.
-- Same contract as the Mastra track (#921), doc/experiments/n8n-vs-mastra.md "Writing step":
--   * an attempt is pinned to one retained source version and one prompt identity for its whole life;
--   * one model call per attempt; a retry reuses saved model output and never calls the model again;
--   * a live call is started only inside begin_model_call, which atomically checks the live switch, the
--     per-platform live call limit and the budget, and marks the call started (so it counts even if the
--     call is interrupted and possibly charged);
--   * a 'calling' attempt whose call cannot still be running was interrupted: live -> provider-uncertain
--     (never resent), fake -> interrupted-fake-call;
--   * articles are immutable (triggers), identified by <attempt>/article@sha256:<hex of the Markdown>.
-- Idempotent: safe to apply on every deploy.

CREATE SCHEMA IF NOT EXISTS steele_wr;

-- Shared prompts, loaded by deploy.sh from experiments/shared/prompts/ exactly as committed.
CREATE TABLE IF NOT EXISTS steele_wr.prompts (
  identity  text PRIMARY KEY,          -- <id>@sha256:<hex of the file bytes>
  name      text NOT NULL,
  sha256    text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content   text NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (identity = name || '@sha256:' || sha256)
);

-- Settings written by deploy.sh from the private stack.env (the live switch and limits).
CREATE TABLE IF NOT EXISTS steele_wr.settings (key text PRIMARY KEY, value text NOT NULL);

CREATE TABLE IF NOT EXISTS steele_wr.attempts (
  attempt           text PRIMARY KEY CHECK (attempt ~ '^n8n-\d{8}T\d{6}Z-[0-9a-f]{4}$'),
  store             text NOT NULL,
  source_version    text NOT NULL,
  mode              text NOT NULL CHECK (mode IN ('fake','live')),
  fake_behaviour    text CHECK (fake_behaviour IN ('valid','malformed','partial','slow')),
  prompt_identity   text NOT NULL REFERENCES steele_wr.prompts (identity),
  rerun_of          text,
  status            text NOT NULL CHECK (status IN ('pending','calling','model-done','saved','failed')),
  model             text,
  raw_output        text,
  usage             jsonb,
  cost_usd          numeric,
  finish_reason     text,
  call_execution    text,
  model_started_at  timestamptz,
  model_finished_at timestamptz,
  article_id        text,
  error             text,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  FOREIGN KEY (store, source_version) REFERENCES steele_src.versions (store, version)
);
CREATE INDEX IF NOT EXISTS attempts_created ON steele_wr.attempts (created_at DESC);

CREATE TABLE IF NOT EXISTS steele_wr.articles (
  article_id      text PRIMARY KEY,
  attempt         text NOT NULL UNIQUE REFERENCES steele_wr.attempts (attempt),
  source_version  text NOT NULL,
  title           text NOT NULL,
  subtitle        text,
  markdown        text NOT NULL,
  article_json    jsonb NOT NULL,
  prompt_identity text NOT NULL,
  model           text NOT NULL,
  created_at      timestamptz NOT NULL,
  CHECK (article_id = attempt || '/article@sha256:' || encode(sha256(convert_to(markdown, 'UTF8')), 'hex'))
);

CREATE OR REPLACE FUNCTION steele_wr.refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% are immutable', TG_TABLE_NAME; END $$;
DROP TRIGGER IF EXISTS articles_immutable ON steele_wr.articles;
CREATE TRIGGER articles_immutable BEFORE UPDATE OR DELETE ON steele_wr.articles
  FOR EACH ROW EXECUTE FUNCTION steele_wr.refuse_change();
DROP TRIGGER IF EXISTS prompts_immutable ON steele_wr.prompts;
CREATE TRIGGER prompts_immutable BEFORE UPDATE OR DELETE ON steele_wr.prompts
  FOR EACH ROW EXECUTE FUNCTION steele_wr.refuse_change();

CREATE OR REPLACE FUNCTION steele_wr.setting(p_key text, p_default text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT value FROM steele_wr.settings WHERE key = p_key), p_default);
$$;

-- Live spend so far on this platform: started live calls (charged or possibly charged) and reported cost.
CREATE OR REPLACE FUNCTION steele_wr.live_ledger() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'liveEnabled', steele_wr.setting('live_enabled', '0') = '1',
    'liveCallsStarted', count(*), 'reportedCostUsd', coalesce(sum(cost_usd), 0),
    'maxLiveCalls', steele_wr.setting('max_live_calls', '1')::integer,
    'liveBudgetUsd', steele_wr.setting('live_budget_usd', '0.05')::numeric)
  FROM steele_wr.attempts WHERE mode = 'live' AND model_started_at IS NOT NULL;
$$;

-- Creates a new attempt pinned to a version and the current prompt. A start or rerun always gets a new ID.
CREATE OR REPLACE FUNCTION steele_wr.create_attempt(
  p_attempt text, p_store text, p_version text, p_mode text, p_fake_behaviour text, p_prompt_name text, p_rerun_of text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_prompt text; v_now timestamptz := clock_timestamp();
BEGIN
  IF p_mode = 'live' AND steele_wr.setting('live_enabled', '0') <> '1' THEN
    RETURN jsonb_build_object('error', 'live-model-disabled');
  END IF;
  SELECT identity INTO v_prompt FROM steele_wr.prompts WHERE name = p_prompt_name ORDER BY loaded_at DESC LIMIT 1;
  IF v_prompt IS NULL THEN RETURN jsonb_build_object('error', 'prompt-not-loaded'); END IF;
  IF NOT EXISTS (SELECT 1 FROM steele_src.versions WHERE store = p_store AND version = p_version) THEN
    RETURN jsonb_build_object('error', 'not-found: no such source version');
  END IF;
  INSERT INTO steele_wr.attempts (attempt, store, source_version, mode, fake_behaviour, prompt_identity, rerun_of, status, created_at, updated_at)
  VALUES (p_attempt, p_store, p_version, p_mode, CASE WHEN p_mode = 'fake' THEN coalesce(p_fake_behaviour, 'valid') END,
          v_prompt, p_rerun_of, 'pending', v_now, v_now);
  RETURN jsonb_build_object('attempt', p_attempt, 'store', p_store, 'sourceVersion', p_version, 'mode', p_mode, 'promptIdentity', v_prompt);
END $$;

-- Everything one run step needs: the attempt, its pinned prompt text, and the live ledger.
CREATE OR REPLACE FUNCTION steele_wr.attempt_context(p_attempt text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT to_jsonb(a) || jsonb_build_object('promptContent', p.content, 'promptSha256', p.sha256,
           'secondsSinceCallStarted', extract(epoch FROM clock_timestamp() - a.model_started_at))
  FROM steele_wr.attempts a JOIN steele_wr.prompts p ON p.identity = a.prompt_identity
  WHERE a.attempt = p_attempt;
$$;

-- The only way a model call starts. For live calls it atomically checks the switch, call limit and budget.
CREATE OR REPLACE FUNCTION steele_wr.begin_model_call(p_attempt text, p_execution text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_mode text; v_status text; v_n integer; v_cost numeric;
BEGIN
  -- Serialise live starts so two attempts cannot both take the last live call.
  PERFORM pg_advisory_xact_lock(hashtext('steele_wr:live'));
  SELECT mode, status INTO v_mode, v_status FROM steele_wr.attempts WHERE attempt = p_attempt FOR UPDATE;
  IF v_status IS NULL OR v_status <> 'pending' THEN RETURN 'already-started'; END IF;
  IF v_mode = 'live' THEN
    IF steele_wr.setting('live_enabled', '0') <> '1' THEN RETURN 'live-model-disabled'; END IF;
    SELECT count(*), coalesce(sum(cost_usd), 0) INTO v_n, v_cost FROM steele_wr.attempts WHERE mode = 'live' AND model_started_at IS NOT NULL;
    IF v_n >= steele_wr.setting('max_live_calls', '1')::integer THEN RETURN 'budget-exceeded: live call limit reached'; END IF;
    IF v_cost + steele_wr.setting('estimated_live_call_usd', '0.01')::numeric > steele_wr.setting('live_budget_usd', '0.05')::numeric THEN
      RETURN 'budget-exceeded: live budget';
    END IF;
  END IF;
  UPDATE steele_wr.attempts SET status = 'calling', model_started_at = clock_timestamp(), call_execution = p_execution,
         updated_at = clock_timestamp() WHERE attempt = p_attempt;
  RETURN 'started';
END $$;

CREATE OR REPLACE FUNCTION steele_wr.save_model_output(
  p_attempt text, p_model text, p_raw text, p_usage jsonb, p_cost numeric, p_finish text) RETURNS boolean LANGUAGE sql AS $$
  UPDATE steele_wr.attempts SET status = 'model-done', model = p_model, raw_output = p_raw, usage = p_usage, cost_usd = p_cost,
         finish_reason = p_finish, model_finished_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE attempt = p_attempt AND status = 'calling'
  RETURNING true;
$$;

-- Records a visible failure. Saved model output (and its usage) is kept; a saved article is never failed.
CREATE OR REPLACE FUNCTION steele_wr.fail_attempt(p_attempt text, p_error text) RETURNS jsonb LANGUAGE sql AS $$
  UPDATE steele_wr.attempts SET status = 'failed', error = left(p_error, 500), updated_at = clock_timestamp()
   WHERE attempt = p_attempt AND status <> 'saved'
  RETURNING jsonb_build_object('attempt', attempt, 'status', status, 'error', error, 'sourceVersion', source_version);
$$;

CREATE OR REPLACE FUNCTION steele_wr.save_article(
  p_article_id text, p_attempt text, p_title text, p_subtitle text, p_markdown text, p_article_json jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a steele_wr.attempts;
BEGIN
  SELECT * INTO a FROM steele_wr.attempts WHERE attempt = p_attempt FOR UPDATE;
  IF a.status = 'saved' THEN RETURN jsonb_build_object('articleId', a.article_id, 'alreadySaved', true); END IF;
  IF a.status <> 'model-done' THEN RAISE EXCEPTION 'attempt % is not ready to save (%)', p_attempt, a.status; END IF;
  INSERT INTO steele_wr.articles (article_id, attempt, source_version, title, subtitle, markdown, article_json, prompt_identity, model, created_at)
  VALUES (p_article_id, p_attempt, a.source_version, p_title, p_subtitle, p_markdown, p_article_json, a.prompt_identity, coalesce(a.model, 'unknown'), clock_timestamp());
  UPDATE steele_wr.attempts SET status = 'saved', article_id = p_article_id, error = NULL, updated_at = clock_timestamp() WHERE attempt = p_attempt;
  RETURN jsonb_build_object('articleId', p_article_id, 'alreadySaved', false);
END $$;

-- Browsing: bounded attempt list, one attempt (without its raw output), one article.
CREATE OR REPLACE FUNCTION steele_wr.list_attempts(p_limit integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('ledger', steele_wr.live_ledger(), 'attempts', coalesce(jsonb_agg(x ORDER BY x->>'createdAt' DESC), '[]'::jsonb)) FROM (
    SELECT jsonb_build_object('attempt', attempt, 'store', store, 'sourceVersion', source_version, 'mode', mode, 'status', status,
             'error', error, 'articleId', article_id, 'model', model, 'costUsd', cost_usd, 'rerunOf', rerun_of, 'createdAt', created_at) x
    FROM steele_wr.attempts ORDER BY created_at DESC LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)) s;
$$;
CREATE OR REPLACE FUNCTION steele_wr.read_attempt(p_attempt text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT to_jsonb(a) - 'raw_output' || jsonb_build_object('rawOutputChars', length(a.raw_output)) FROM steele_wr.attempts a WHERE attempt = p_attempt;
$$;
CREATE OR REPLACE FUNCTION steele_wr.read_article(p_article_id text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT to_jsonb(r) FROM steele_wr.articles r WHERE article_id = p_article_id;
$$;
