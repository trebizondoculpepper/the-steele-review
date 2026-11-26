-- Delivery of saved articles to the shared draft service (#917), in the experiment's own database.
-- Same contract as the Mastra track (#922): the request ID is exp-911:n8n:<attempt>, built only from the
-- immutable saved article and its pinned source; the outcome, draft ID, receipt and readback are recorded.
-- Idempotent: safe to apply on every deploy.

CREATE SCHEMA IF NOT EXISTS steele_dl;

CREATE TABLE IF NOT EXISTS steele_dl.deliveries (
  request_id     text NOT NULL CHECK (request_id ~ '^exp-911:n8n:n8n-\d{8}T\d{6}Z-[0-9a-f]{4}$'),
  article_id     text NOT NULL REFERENCES steele_wr.articles (article_id),
  target         text NOT NULL CHECK (target IN ('service','fake')),
  payload_sha256 text NOT NULL,
  status         text NOT NULL,
  draft_id       text,
  receipt_id     text,
  readback       jsonb,
  history        jsonb NOT NULL,
  error          text,
  first_at       timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  -- One record per destination: a test-double delivery can never merge into a real one, or the reverse.
  PRIMARY KEY (target, request_id)
);
-- Migration for databases created when the key was request_id alone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
             WHERE c.conname = 'deliveries_pkey' AND c.conrelid = 'steele_dl.deliveries'::regclass
             GROUP BY c.oid HAVING count(*) = 1) THEN
    ALTER TABLE steele_dl.deliveries DROP CONSTRAINT deliveries_pkey;
    ALTER TABLE steele_dl.deliveries ADD PRIMARY KEY (target, request_id);
  END IF;
END $$;

-- The exact request for one saved article, from storage only. Same shape and labelling as the contract.
CREATE OR REPLACE FUNCTION steele_dl.build_request(p_article_id text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'requestId', 'exp-911:n8n:' || a.attempt,
    'experiment', 'exp-911',
    'platform', 'n8n',
    'attempt', a.attempt,
    'title', left('[exp-911 n8n ' || a.attempt || '] ' || a.title, 280),
    'subtitle', left(a.subtitle, 300),
    'bodyMarkdown', a.markdown,
    'source', jsonb_build_object('item', v.item, 'version', v.version, 'url', (v.bundle_bytes::jsonb)->>'url'),
    'article', a.article_id))
  FROM steele_wr.articles a
  JOIN steele_wr.attempts t ON t.attempt = a.attempt
  JOIN steele_src.versions v ON v.store = t.store AND v.version = a.source_version
  WHERE a.article_id = p_article_id;
$$;

CREATE OR REPLACE FUNCTION steele_dl.record(p_request_id text, p_article_id text, p_target text, p_payload_sha256 text,
  p_status text, p_draft_id text, p_receipt_id text, p_readback jsonb, p_history jsonb, p_error text) RETURNS jsonb LANGUAGE sql AS $$
  INSERT INTO steele_dl.deliveries (request_id, article_id, target, payload_sha256, status, draft_id, receipt_id, readback, history, error, first_at, updated_at)
  VALUES (p_request_id, p_article_id, p_target, p_payload_sha256, p_status, p_draft_id, p_receipt_id, p_readback, p_history, p_error, clock_timestamp(), clock_timestamp())
  ON CONFLICT (target, request_id) DO UPDATE SET status = excluded.status, draft_id = coalesce(excluded.draft_id, steele_dl.deliveries.draft_id),
    receipt_id = coalesce(excluded.receipt_id, steele_dl.deliveries.receipt_id), readback = coalesce(nullif(excluded.readback, 'null'::jsonb), steele_dl.deliveries.readback),
    history = steele_dl.deliveries.history || excluded.history, error = excluded.error, updated_at = clock_timestamp()
  RETURNING jsonb_build_object('requestId', request_id, 'target', target, 'status', status, 'draftId', draft_id, 'receiptId', receipt_id, 'tries', jsonb_array_length(history));
$$;

CREATE OR REPLACE FUNCTION steele_dl.list(p_limit integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'updatedAt' DESC), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('requestId', request_id, 'articleId', article_id, 'target', target, 'status', status, 'draftId', draft_id,
             'receiptId', receipt_id, 'readback', readback, 'tries', jsonb_array_length(history), 'error', error, 'updatedAt', updated_at) x
    FROM steele_dl.deliveries ORDER BY updated_at DESC LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)) s;
$$;
-- Every destination's record for one request ID, each with its own target, status, draft and receipt.
DROP FUNCTION IF EXISTS steele_dl.read(text);
CREATE OR REPLACE FUNCTION steele_dl.read(p_request_id text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_build_object('requestId', p_request_id,
    'records', jsonb_agg(to_jsonb(d) ORDER BY d.target)) END
  FROM steele_dl.deliveries d WHERE request_id = p_request_id;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Test double of the draft service (#917): the same routes, statuses and HTTP codes as
-- experiments/draft-service, with scenarios that reproduce its failure modes. State is in the database,
-- so it survives an n8n restart like the real service's store. Used only with target 'fake'.
CREATE SCHEMA IF NOT EXISTS steele_fake;
CREATE TABLE IF NOT EXISTS steele_fake.drafts (
  request_id   text PRIMARY KEY,
  payload_hash text NOT NULL,
  title        text NOT NULL,
  state        text NOT NULL CHECK (state IN ('created','uncertain')),
  draft_id     text NOT NULL,
  receipt_id   text NOT NULL,
  creates      integer NOT NULL DEFAULT 1,
  lost_once    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Scenario per request ID: normal | lost-response | uncertain-once
CREATE TABLE IF NOT EXISTS steele_fake.scenarios (request_id text PRIMARY KEY, scenario text NOT NULL);

CREATE OR REPLACE FUNCTION steele_fake.view(d steele_fake.drafts, p_status text, p_http integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('httpStatus', p_http, 'body', jsonb_build_object('status', p_status, 'requestId', d.request_id, 'draftId', d.draft_id,
    'receiptId', d.receipt_id, 'payloadHash', d.payload_hash, 'createAttempts', d.creates,
    'editorUrl', CASE WHEN d.state = 'created' THEN 'https://fake-draft.invalid/drafts/' || d.draft_id END,
    'readback', CASE WHEN d.state = 'created' THEN jsonb_build_object('titleMatches', true, 'published', false, 'emailSent', false) END));
$$;

CREATE OR REPLACE FUNCTION steele_fake.handle(p_route text, p_request_id text, p_payload jsonb, p_platform text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d steele_fake.drafts; v_hash text; v_scenario text;
BEGIN
  IF p_platform IS DISTINCT FROM 'n8n' THEN RETURN jsonb_build_object('httpStatus', 403, 'body', jsonb_build_object('status', 'forbidden')); END IF;
  SELECT * INTO d FROM steele_fake.drafts WHERE request_id = p_request_id FOR UPDATE;
  v_scenario := coalesce((SELECT scenario FROM steele_fake.scenarios WHERE request_id = p_request_id), 'normal');
  IF p_route = 'deliver' THEN
    v_hash := encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex');
    IF p_payload->>'platform' IS DISTINCT FROM 'n8n' THEN RETURN jsonb_build_object('httpStatus', 403, 'body', jsonb_build_object('status', 'forbidden')); END IF;
    IF d.request_id IS NOT NULL THEN
      IF d.payload_hash <> v_hash THEN
        RETURN jsonb_build_object('httpStatus', 409, 'body', jsonb_build_object('status', 'conflict', 'requestId', p_request_id, 'error', 'same request ID, different payload'));
      END IF;
      IF d.state = 'created' THEN RETURN steele_fake.view(d, 'existing', 200); END IF;
      RETURN steele_fake.view(d, 'uncertain', 503);
    END IF;
    INSERT INTO steele_fake.drafts (request_id, payload_hash, title, state, draft_id, receipt_id)
    VALUES (p_request_id, v_hash, p_payload->>'title', CASE WHEN v_scenario = 'uncertain-once' THEN 'uncertain' ELSE 'created' END,
            'fake-' || substr(md5(p_request_id), 1, 10), 'fake-receipt-' || substr(md5(p_request_id || 'r'), 1, 10))
    RETURNING * INTO d;
    -- The draft now exists, but the answer is lost on the way back (the caller sees no usable response).
    IF v_scenario = 'lost-response' THEN
      UPDATE steele_fake.drafts SET lost_once = true WHERE request_id = p_request_id;
      RETURN jsonb_build_object('httpStatus', 502, 'lost', true);
    END IF;
    IF d.state = 'uncertain' THEN RETURN steele_fake.view(d, 'uncertain', 503); END IF;
    RETURN steele_fake.view(d, 'created', 201);
  ELSIF p_route = 'reconcile' THEN
    IF d.request_id IS NULL THEN RETURN jsonb_build_object('httpStatus', 404, 'body', jsonb_build_object('status', 'not-found', 'requestId', p_request_id)); END IF;
    -- Reconciliation finds the matching draft at the destination; it never creates one.
    UPDATE steele_fake.drafts SET state = 'created' WHERE request_id = p_request_id RETURNING * INTO d;
    RETURN steele_fake.view(d, 'existing', 200);
  ELSIF p_route = 'status' THEN
    IF d.request_id IS NULL THEN RETURN jsonb_build_object('httpStatus', 404, 'body', jsonb_build_object('status', 'not-found', 'requestId', p_request_id)); END IF;
    RETURN steele_fake.view(d, CASE WHEN d.state = 'created' THEN 'existing' ELSE 'uncertain' END, CASE WHEN d.state = 'created' THEN 200 ELSE 503 END);
  END IF;
  RETURN jsonb_build_object('httpStatus', 404, 'body', jsonb_build_object('status', 'not-found'));
END $$;
