-- Durable discovery state for the n8n track (#914), in the experiment's own database.
-- Same semantics as the Mastra track (#919):
--   * the first successful poll of a subscription is its baseline: every item then present
--     is recorded as 'baseline' and is never submitted automatically;
--   * an item first seen after the baseline is 'new' and needs capture;
--   * an item whose observed metadata changes needs capture again (change_count + 1);
--   * an unchanged feed only refreshes last_seen_at, so it can never cause repeated work;
--   * an operator can select any post on the publication; it then needs capture.
-- needs_capture is the durable hand-off to capture (#915); only capture clears it.
-- Each subscription is isolated, so the controlled test fixture never touches the real feed's state.
-- Idempotent: safe to apply on every deploy.

CREATE SCHEMA IF NOT EXISTS steele_feed;

CREATE TABLE IF NOT EXISTS steele_feed.items (
  subscription  text NOT NULL,
  canonical_url text NOT NULL,
  slug          text NOT NULL,
  post_id       text,
  source_item   text,
  title         text NOT NULL DEFAULT '',
  published_at  timestamptz,
  medium        text NOT NULL CHECK (medium IN ('audio','video','written','unknown')),
  fingerprint   text NOT NULL,
  status        text NOT NULL CHECK (status IN ('baseline','new','selected')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL,
  change_count  integer NOT NULL DEFAULT 0,
  needs_capture boolean NOT NULL DEFAULT false,
  capture_error text,
  PRIMARY KEY (subscription, canonical_url)
);

-- Bounded capture retries (#915): attempts since the item was last queued, and when the last one ran.
ALTER TABLE steele_feed.items ADD COLUMN IF NOT EXISTS capture_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE steele_feed.items ADD COLUMN IF NOT EXISTS last_capture_attempt_at timestamptz;
-- Queue generation: bumped every time an item is queued (new, edited or selected). A capture's
-- acknowledgement clears the queue only for the generation it processed, so an edit recorded while a
-- capture is running stays queued.
ALTER TABLE steele_feed.items ADD COLUMN IF NOT EXISTS capture_generation integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS steele_feed.polls (
  poll_id       text PRIMARY KEY,
  subscription  text NOT NULL,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('ok','failed')),
  http_status   integer,
  item_count    integer NOT NULL DEFAULT 0,
  new_count     integer NOT NULL DEFAULT 0,
  changed_count integer NOT NULL DEFAULT 0,
  baseline      boolean NOT NULL DEFAULT false,
  error         text
);
CREATE INDEX IF NOT EXISTS polls_subscription_finished ON steele_feed.polls (subscription, finished_at DESC);

-- Records one successful observation atomically and returns what it found.
-- items: [{canonicalUrl, slug, postId, sourceItem, title, publishedAt, medium, fingerprint}]
CREATE OR REPLACE FUNCTION steele_feed.record_observation(
  p_subscription text, p_poll_id text, p_started_at timestamptz, p_http_status integer, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_baseline boolean;
  v_item jsonb;
  v_prev text;
  v_new jsonb := '[]'::jsonb;
  v_changed jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_items) <> 'array' THEN RAISE EXCEPTION 'items must be an array'; END IF;
  -- Serialise observations of one subscription so two overlapping polls cannot both be the baseline.
  PERFORM pg_advisory_xact_lock(hashtext('steele_feed:' || p_subscription));
  -- A repeated delivery of the same poll is a no-op.
  IF EXISTS (SELECT 1 FROM steele_feed.polls WHERE poll_id = p_poll_id) THEN
    RETURN jsonb_build_object('pollId', p_poll_id, 'duplicatePoll', true);
  END IF;
  v_baseline := NOT EXISTS (SELECT 1 FROM steele_feed.polls WHERE subscription = p_subscription AND outcome = 'ok');
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT fingerprint INTO v_prev FROM steele_feed.items
      WHERE subscription = p_subscription AND canonical_url = v_item->>'canonicalUrl' FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO steele_feed.items (subscription, canonical_url, slug, post_id, source_item, title, published_at, medium,
                                     fingerprint, status, first_seen_at, last_seen_at, needs_capture)
      VALUES (p_subscription, v_item->>'canonicalUrl', v_item->>'slug', v_item->>'postId', v_item->>'sourceItem',
              coalesce(v_item->>'title',''), (v_item->>'publishedAt')::timestamptz, v_item->>'medium', v_item->>'fingerprint',
              CASE WHEN v_baseline THEN 'baseline' ELSE 'new' END, v_now, v_now, NOT v_baseline);
      IF NOT v_baseline THEN v_new := v_new || jsonb_build_array(v_item->>'canonicalUrl'); END IF;
    ELSIF v_prev = 'manual' OR (v_baseline AND v_prev <> v_item->>'fingerprint') THEN
      -- A manually selected placeholder, or a row met during activation: fill in metadata without reporting an edit.
      UPDATE steele_feed.items SET post_id = coalesce(v_item->>'postId', post_id), source_item = coalesce(v_item->>'sourceItem', source_item),
             title = coalesce(v_item->>'title',''), published_at = (v_item->>'publishedAt')::timestamptz, medium = v_item->>'medium',
             fingerprint = v_item->>'fingerprint', last_seen_at = v_now
       WHERE subscription = p_subscription AND canonical_url = v_item->>'canonicalUrl';
    ELSIF v_prev <> v_item->>'fingerprint' THEN
      UPDATE steele_feed.items SET post_id = coalesce(v_item->>'postId', post_id), source_item = coalesce(v_item->>'sourceItem', source_item),
             title = coalesce(v_item->>'title',''), published_at = (v_item->>'publishedAt')::timestamptz, medium = v_item->>'medium',
             fingerprint = v_item->>'fingerprint', last_seen_at = v_now, change_count = change_count + 1,
             needs_capture = true, capture_error = NULL, capture_attempts = 0, last_capture_attempt_at = NULL,
             capture_generation = capture_generation + 1
       WHERE subscription = p_subscription AND canonical_url = v_item->>'canonicalUrl';
      v_changed := v_changed || jsonb_build_array(v_item->>'canonicalUrl');
    ELSE
      UPDATE steele_feed.items SET last_seen_at = v_now
       WHERE subscription = p_subscription AND canonical_url = v_item->>'canonicalUrl';
    END IF;
  END LOOP;
  INSERT INTO steele_feed.polls (poll_id, subscription, started_at, finished_at, outcome, http_status, item_count,
                                 new_count, changed_count, baseline)
  VALUES (p_poll_id, p_subscription, p_started_at, v_now, 'ok', p_http_status, jsonb_array_length(p_items),
          jsonb_array_length(v_new), jsonb_array_length(v_changed), v_baseline);
  RETURN jsonb_build_object('pollId', p_poll_id, 'subscription', p_subscription, 'baseline', v_baseline,
                            'itemCount', jsonb_array_length(p_items), 'new', v_new, 'changed', v_changed);
END $$;

CREATE OR REPLACE FUNCTION steele_feed.record_failure(
  p_subscription text, p_poll_id text, p_started_at timestamptz, p_http_status integer, p_error text)
RETURNS jsonb LANGUAGE sql AS $$
  INSERT INTO steele_feed.polls (poll_id, subscription, started_at, finished_at, outcome, http_status, error)
  VALUES (p_poll_id, p_subscription, p_started_at, clock_timestamp(), 'failed', p_http_status, left(p_error, 1000))
  ON CONFLICT (poll_id) DO NOTHING
  RETURNING jsonb_build_object('pollId', poll_id, 'outcome', outcome, 'error', error);
$$;

-- Operator selection of one post (an older item, or one not in the feed). Never fetches anything.
CREATE OR REPLACE FUNCTION steele_feed.select_item(p_subscription text, p_canonical_url text, p_slug text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_now timestamptz := clock_timestamp(); v_created boolean;
BEGIN
  INSERT INTO steele_feed.items (subscription, canonical_url, slug, medium, fingerprint, status, first_seen_at, last_seen_at, needs_capture)
  VALUES (p_subscription, p_canonical_url, p_slug, 'unknown', 'manual', 'selected', v_now, v_now, true)
  ON CONFLICT (subscription, canonical_url) DO UPDATE
    SET status = 'selected', needs_capture = true, capture_error = NULL, last_seen_at = v_now,
        capture_attempts = 0, last_capture_attempt_at = NULL,
        capture_generation = steele_feed.items.capture_generation + 1
  RETURNING (xmax = 0) INTO v_created;
  RETURN jsonb_build_object('subscription', p_subscription, 'canonicalUrl', p_canonical_url, 'created', v_created, 'needsCapture', true);
END $$;

-- Status for operators and agents: last poll, last failure, counts and the capture queue.
CREATE OR REPLACE FUNCTION steele_feed.status(p_subscription text)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'subscription', p_subscription,
    'activated', EXISTS (SELECT 1 FROM steele_feed.polls WHERE subscription = p_subscription AND outcome = 'ok'),
    'lastPoll', (SELECT to_jsonb(p) - 'subscription' FROM steele_feed.polls p WHERE subscription = p_subscription ORDER BY finished_at DESC LIMIT 1),
    'lastFailure', (SELECT to_jsonb(p) - 'subscription' FROM steele_feed.polls p WHERE subscription = p_subscription AND outcome = 'failed' ORDER BY finished_at DESC LIMIT 1),
    'counts', (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM steele_feed.items WHERE subscription = p_subscription GROUP BY status) s),
    'pendingCapture', coalesce((SELECT jsonb_agg(jsonb_build_object('canonicalUrl', canonical_url, 'status', status, 'title', title, 'lastSeenAt', last_seen_at,
                                  'captureAttempts', capture_attempts, 'lastCaptureError', capture_error) ORDER BY last_seen_at)
                                FROM steele_feed.items WHERE subscription = p_subscription AND needs_capture), '[]'::jsonb),
    'captureFailures', coalesce((SELECT jsonb_agg(jsonb_build_object('canonicalUrl', canonical_url, 'error', capture_error, 'attempts', capture_attempts))
                                FROM steele_feed.items WHERE subscription = p_subscription AND NOT needs_capture AND capture_error IS NOT NULL), '[]'::jsonb),
    'recentItems', coalesce((SELECT jsonb_agg(x) FROM (SELECT jsonb_build_object('canonicalUrl', canonical_url, 'title', title, 'status', status, 'publishedAt', published_at, 'medium', medium, 'changeCount', change_count) x
                                FROM steele_feed.items WHERE subscription = p_subscription ORDER BY published_at DESC NULLS LAST LIMIT 10) r), '[]'::jsonb));
$$;
