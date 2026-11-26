-- Immutable retained source versions for the n8n track (#915), in the experiment's own database.
-- Same contract as the Mastra track (#920), doc/experiments/n8n-vs-mastra.md:
--   * a version is the canonical source-bundle-v1 bytes; its ID is <item>@sha256:<hex of those bytes>;
--   * a version row is never updated or deleted (enforced here by triggers, not only by callers);
--     capturing identical content again reuses the version and records the observation;
--   * the original post JSON (signed links removed) and supplied transcript JSON are kept beside it;
--   * capture metadata and warnings are stored next to the bundle, never inside it.
-- 'store' separates the live store from isolated fixture-* test stores.
-- Hashes are computed and verified by the workflows (RFC 8785 + SHA-256); the database also
-- checks that the stored sha256 matches the bytes, so a row can never disagree with its ID.
-- Idempotent: safe to apply on every deploy.

CREATE SCHEMA IF NOT EXISTS steele_src;

CREATE TABLE IF NOT EXISTS steele_src.versions (
  store            text NOT NULL,
  version          text NOT NULL,
  item             text NOT NULL,
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bundle_bytes     text NOT NULL,
  raw_post         text,
  raw_transcript   text,
  capture_meta     jsonb NOT NULL,
  warnings         jsonb NOT NULL,
  text_source      text NOT NULL,
  text_chars       integer NOT NULL,
  captured_at      timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  observations     integer NOT NULL DEFAULT 1,
  PRIMARY KEY (store, version),
  CHECK (version = item || '@sha256:' || sha256)
);
CREATE INDEX IF NOT EXISTS versions_item ON steele_src.versions (store, item, captured_at DESC);

CREATE OR REPLACE FUNCTION steele_src.refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'source versions are immutable'; END IF;
  IF (NEW.store, NEW.version, NEW.item, NEW.sha256, NEW.bundle_bytes, NEW.raw_post, NEW.raw_transcript, NEW.capture_meta,
      NEW.warnings, NEW.text_source, NEW.text_chars, NEW.captured_at)
     IS DISTINCT FROM
     (OLD.store, OLD.version, OLD.item, OLD.sha256, OLD.bundle_bytes, OLD.raw_post, OLD.raw_transcript, OLD.capture_meta,
      OLD.warnings, OLD.text_source, OLD.text_chars, OLD.captured_at)
  THEN RAISE EXCEPTION 'source versions are immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS versions_immutable ON steele_src.versions;
CREATE TRIGGER versions_immutable BEFORE UPDATE OR DELETE ON steele_src.versions
  FOR EACH ROW EXECUTE FUNCTION steele_src.refuse_change();

-- Bytes must hash to the stored sha256 (the workflows compute it; this is a second, independent check).
CREATE OR REPLACE FUNCTION steele_src.check_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF encode(sha256(convert_to(NEW.bundle_bytes, 'UTF8')), 'hex') <> NEW.sha256 THEN
    RAISE EXCEPTION 'bundle bytes do not match sha256';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS versions_hash ON steele_src.versions;
CREATE TRIGGER versions_hash BEFORE INSERT ON steele_src.versions
  FOR EACH ROW EXECUTE FUNCTION steele_src.check_hash();

-- Saves a version, or records another observation of identical content. Returns {version, created}.
CREATE OR REPLACE FUNCTION steele_src.save_version(
  p_store text, p_item text, p_sha256 text, p_bundle_bytes text, p_raw_post text, p_raw_transcript text,
  p_capture_meta jsonb, p_warnings jsonb, p_text_source text, p_text_chars integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_version text := p_item || '@sha256:' || p_sha256; v_now timestamptz := clock_timestamp(); v_created boolean;
BEGIN
  INSERT INTO steele_src.versions (store, version, item, sha256, bundle_bytes, raw_post, raw_transcript, capture_meta, warnings,
                                   text_source, text_chars, captured_at, last_observed_at)
  VALUES (p_store, v_version, p_item, p_sha256, p_bundle_bytes, p_raw_post, p_raw_transcript, p_capture_meta, p_warnings,
          p_text_source, p_text_chars, v_now, v_now)
  ON CONFLICT (store, version) DO UPDATE SET last_observed_at = excluded.last_observed_at,
                                             observations = steele_src.versions.observations + 1
  RETURNING (xmax = 0) INTO v_created;
  RETURN jsonb_build_object('store', p_store, 'version', v_version, 'created', v_created);
END $$;

CREATE OR REPLACE FUNCTION steele_src.summary(v steele_src.versions) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('version', v.version, 'item', v.item, 'sha256', v.sha256, 'capturedAt', v.captured_at,
    'lastObservedAt', v.last_observed_at, 'observations', v.observations, 'textSource', v.text_source,
    'textChars', v.text_chars, 'warnings', v.warnings);
$$;

-- listItems: source items newest first, each with its latest version (limit 1..50).
CREATE OR REPLACE FUNCTION steele_src.list_items(p_store text, p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'latestCapturedAt' DESC), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('item', item, 'versions', count(*),
      'latestCapturedAt', max(captured_at),
      'latestVersion', (array_agg(version ORDER BY captured_at DESC, version))[1]) x
    FROM steele_src.versions WHERE store = p_store GROUP BY item
    ORDER BY max(captured_at) DESC LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)) s;
$$;

-- listVersions: one page of an item's versions, newest first; total makes every version reachable.
CREATE OR REPLACE FUNCTION steele_src.list_versions(p_store text, p_item text, p_limit integer, p_offset integer)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'item', p_item,
    'total', (SELECT count(*) FROM steele_src.versions WHERE store = p_store AND item = p_item),
    'offset', greatest(coalesce(p_offset, 0), 0),
    'versions', coalesce((SELECT jsonb_agg(steele_src.summary(v) ORDER BY v.captured_at DESC, v.version) FROM (
        SELECT * FROM steele_src.versions WHERE store = p_store AND item = p_item
        ORDER BY captured_at DESC, version
        LIMIT least(greatest(coalesce(p_limit, 50), 1), 100) OFFSET greatest(coalesce(p_offset, 0), 0)) v), '[]'::jsonb));
$$;

-- readVersion / exportVersion: the stored row, read from storage only (the caller re-verifies the hash).
CREATE OR REPLACE FUNCTION steele_src.read_version(p_store text, p_version text)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT steele_src.summary(v) || jsonb_build_object('bundleBytes', v.bundle_bytes, 'rawPost', v.raw_post,
    'rawTranscript', v.raw_transcript, 'captureMeta', v.capture_meta)
  FROM steele_src.versions v WHERE store = p_store AND version = p_version;
$$;

-- Capture queue hand-off from discovery (#914). Items never tried come first, then the least recently
-- tried, so an item that keeps failing cannot starve the ones queued after it.
CREATE OR REPLACE FUNCTION steele_src.pending_capture(p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('canonicalUrl', canonical_url, 'status', status, 'attempts', capture_attempts,
                                               'generation', capture_generation)), '[]'::jsonb)
  FROM (SELECT * FROM steele_feed.items WHERE subscription = 'saveusnow' AND needs_capture
        ORDER BY last_capture_attempt_at NULLS FIRST, last_seen_at LIMIT least(greatest(coalesce(p_limit, 3), 1), 10)) i;
$$;

-- Records one capture attempt's outcome for the queue generation it processed. Success clears the queue
-- flag. A permanent failure (the post is gone, restricted or not on the publication) leaves the queue
-- with its reason. A transient failure stays queued until 5 attempts, then leaves the queue as
-- 'retries-exhausted: <last error>'. If the item was queued again meanwhile (a newer generation), the
-- outcome is stale: the item stays queued with its fresh budget. A later edit or selection re-queues it.
DROP FUNCTION IF EXISTS steele_src.capture_done(text, text);
DROP FUNCTION IF EXISTS steele_src.capture_outcome(text, boolean, boolean, text);
CREATE OR REPLACE FUNCTION steele_src.capture_outcome(p_canonical_url text, p_generation integer, p_ok boolean, p_permanent boolean, p_error text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_attempts integer; v_queued boolean;
BEGIN
  UPDATE steele_feed.items SET
    capture_attempts = CASE WHEN p_ok THEN 0 ELSE capture_attempts + 1 END,
    last_capture_attempt_at = clock_timestamp(),
    needs_capture = NOT (p_ok OR p_permanent OR capture_attempts + 1 >= 5),
    capture_error = CASE WHEN p_ok THEN NULL
                         WHEN p_permanent THEN left(p_error, 500)
                         WHEN capture_attempts + 1 >= 5 THEN left('retries-exhausted: ' || p_error, 500)
                         ELSE left(p_error, 500) END
   WHERE subscription = 'saveusnow' AND canonical_url = p_canonical_url AND capture_generation = p_generation
  RETURNING capture_attempts, needs_capture INTO v_attempts, v_queued;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('canonicalUrl', p_canonical_url, 'stale', true, 'stillQueued',
      (SELECT needs_capture FROM steele_feed.items WHERE subscription = 'saveusnow' AND canonical_url = p_canonical_url));
  END IF;
  RETURN jsonb_build_object('canonicalUrl', p_canonical_url, 'attempts', v_attempts, 'stillQueued', v_queued);
END $$;
