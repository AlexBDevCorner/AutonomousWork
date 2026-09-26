-- Permanent live review queue. Enrolled project authorization is checked in the trusted workflow.
CREATE OR REPLACE FUNCTION review_bridge.claim_live_queue(p_id uuid)
RETURNS SETOF public.autonomous_review_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $claim$
BEGIN
  RETURN QUERY UPDATE public.autonomous_review_queue AS q
  SET status = 'processing',
      attempts = q.attempts + 1,
      claimed_at = now(),
      lease_until = now() + interval '15 minutes',
      claim_token = gen_random_uuid(),
      processed_at = NULL, last_error = NULL,
      validation_result = '{}'::jsonb,
      updated_at = now()
  WHERE q.id = p_id
    AND q.test_only = false
    AND q.source = 'chatgpt-scheduled'
    AND q.schema_version = 1
    AND q.repository ~ '^AlexBDevCorner/[A-Za-z0-9_.-]+$'
    AND q.attempts < 4
    AND (
      q.status IN ('queued','retryable')
      OR (q.status = 'processing' AND q.lease_until < now())
    )
  RETURNING q.*;
END;
$claim$;

CREATE OR REPLACE FUNCTION review_bridge.finish_live_queue(
  p_id uuid, p_token uuid, p_status text,
  p_reason text DEFAULT NULL, p_evidence jsonb DEFAULT '{}'::jsonb,
  p_review_id bigint DEFAULT NULL, p_merge_sha text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $finish$
DECLARE affected integer;
BEGIN
  IF p_status NOT IN ('applied','stale','withheld','failed','retryable')
    OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object'
    OR octet_length(p_evidence::text) > 4096
    OR (p_reason IS NOT NULL AND length(p_reason) > 500)
    OR (p_review_id IS NOT NULL AND p_review_id < 1)
    OR (p_merge_sha IS NOT NULL AND p_merge_sha !~ '^[a-f0-9]{40}$')
    OR (p_status <> 'applied' AND (p_review_id IS NOT NULL OR p_merge_sha IS NOT NULL))
    OR (p_status = 'applied' AND p_review_id IS NULL AND p_merge_sha IS NULL)
  THEN
    RETURN FALSE;
  END IF;

  UPDATE public.autonomous_review_queue AS q
  SET status = p_status, claim_token = NULL, lease_until = NULL,
      last_error = p_reason, validation_result = p_evidence,
      github_review_id = p_review_id, merge_sha = p_merge_sha,
      processed_at = CASE WHEN p_status = 'retryable' THEN NULL ELSE now() END,
      updated_at = now()
  WHERE q.id = p_id AND q.claim_token = p_token
    AND q.status = 'processing' AND q.lease_until > now()
    AND q.test_only = false AND q.source = 'chatgpt-scheduled'
    AND q.repository ~ '^AlexBDevCorner/[A-Za-z0-9_.-]+$';

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$finish$;

REVOKE ALL ON FUNCTION review_bridge.claim_live_queue(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION review_bridge.finish_live_queue(uuid,uuid,text,text,jsonb,bigint,text)
  FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA review_bridge TO service_role;
GRANT EXECUTE ON FUNCTION review_bridge.claim_live_queue(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION review_bridge.finish_live_queue(uuid,uuid,text,text,jsonb,bigint,text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.review_bridge_claim_live_queue(p_id uuid)
RETURNS SETOF public.autonomous_review_queue
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $wrapper$
  SELECT * FROM review_bridge.claim_live_queue(p_id);
$wrapper$;
CREATE OR REPLACE FUNCTION public.review_bridge_finish_live_queue(
  p_id uuid, p_token uuid, p_status text,
  p_reason text DEFAULT NULL, p_evidence jsonb DEFAULT '{}'::jsonb,
  p_review_id bigint DEFAULT NULL, p_merge_sha text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $wrapper$
  SELECT review_bridge.finish_live_queue(
    p_id,p_token,p_status,p_reason,p_evidence,p_review_id,p_merge_sha
  );
$wrapper$;
REVOKE ALL ON FUNCTION public.review_bridge_claim_live_queue(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.review_bridge_finish_live_queue(uuid,uuid,text,text,jsonb,bigint,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_bridge_claim_live_queue(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_bridge_finish_live_queue(uuid,uuid,text,text,jsonb,bigint,text)
  TO service_role;

-- Historical migration remains for reproducibility; only permanent RPCs remain active.
DROP FUNCTION IF EXISTS public.review_bridge_claim_mss_pilot_queue(uuid);
DROP FUNCTION IF EXISTS public.review_bridge_finish_mss_pilot_queue(uuid,uuid,text,text,jsonb,bigint,text);
DROP FUNCTION IF EXISTS review_bridge.claim_mss_pilot_queue(uuid);
DROP FUNCTION IF EXISTS review_bridge.finish_mss_pilot_queue(uuid,uuid,text,text,jsonb,bigint,text);
