-- Step 3 is restricted to test_only=true. This migration never enables PR writes.
ALTER TABLE public.autonomous_review_queue
  ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE public.autonomous_review_queue
  ADD COLUMN IF NOT EXISTS validation_result jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.autonomous_review_queue'::regclass
      AND conname = 'autonomous_review_validation_object'
  ) THEN
    ALTER TABLE public.autonomous_review_queue
      ADD CONSTRAINT autonomous_review_validation_object
      CHECK (jsonb_typeof(validation_result) = 'object');
  END IF;
END;
$guard$;

-- Security-definer operations live only in this non-exposed schema.
-- Public-facing wrappers are SECURITY INVOKER and executable only by service_role.
CREATE OR REPLACE FUNCTION review_bridge.claim_test_queue(p_id uuid)
RETURNS SETOF public.autonomous_review_queue
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $claim$
BEGIN
  RETURN QUERY UPDATE public.autonomous_review_queue AS queue
  SET status = 'processing',
      attempts = queue.attempts + 1,
      claimed_at = now(),
      lease_until = now() + interval '15 minutes',
      claim_token = gen_random_uuid(),
      processed_at = NULL,
      last_error = NULL,
      validation_result = '{}'::jsonb,
      updated_at = now()
  WHERE queue.id = p_id
    AND queue.test_only = true
    AND queue.attempts < 4
    AND (
      queue.status IN ('queued','retryable')
      OR (queue.status = 'processing' AND queue.lease_until < now())
    )
  RETURNING queue.*;
END;
$claim$;

CREATE OR REPLACE FUNCTION review_bridge.finish_test_queue(
  p_id uuid, p_token uuid, p_status text,
  p_reason text DEFAULT NULL, p_evidence jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $finish$
DECLARE affected integer;
BEGIN
  IF p_status NOT IN ('dry_run','stale','withheld','failed','retryable')
    OR p_evidence IS NULL
    OR jsonb_typeof(p_evidence) <> 'object'
    OR octet_length(p_evidence::text) > 4096
    OR (p_reason IS NOT NULL AND length(p_reason) > 500) THEN
    RETURN FALSE;
  END IF;

  UPDATE public.autonomous_review_queue AS queue
  SET status = p_status,
      claim_token = NULL,
      lease_until = NULL,
      last_error = p_reason,
      validation_result = p_evidence,
      processed_at = CASE WHEN p_status = 'retryable' THEN NULL ELSE now() END,
      updated_at = now()
  WHERE queue.id = p_id
    AND queue.claim_token = p_token
    AND queue.status = 'processing'
    AND queue.test_only = true
    AND queue.lease_until > now();

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$finish$;

REVOKE ALL ON FUNCTION review_bridge.claim_test_queue(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION review_bridge.finish_test_queue(uuid,uuid,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA review_bridge TO service_role;
GRANT EXECUTE ON FUNCTION review_bridge.claim_test_queue(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION review_bridge.finish_test_queue(uuid,uuid,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.review_bridge_claim_test_queue(p_id uuid)
RETURNS SETOF public.autonomous_review_queue
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $wrapper$
  SELECT * FROM review_bridge.claim_test_queue(p_id);
$wrapper$;

CREATE OR REPLACE FUNCTION public.review_bridge_finish_test_queue(
  p_id uuid, p_token uuid, p_status text,
  p_reason text DEFAULT NULL, p_evidence jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $wrapper$
  SELECT review_bridge.finish_test_queue(
    p_id, p_token, p_status, p_reason, p_evidence
  );
$wrapper$;

REVOKE ALL ON FUNCTION public.review_bridge_claim_test_queue(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.review_bridge_finish_test_queue(uuid,uuid,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_bridge_claim_test_queue(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_bridge_finish_test_queue(uuid,uuid,text,text,jsonb) TO service_role;
