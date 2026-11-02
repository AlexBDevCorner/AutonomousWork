-- Event-driven OpenCode reviewer (#37). GitHub Actions proposes verdicts through the
-- queue-scoped Edge API; the bridge still performs every GitHub review/merge guard.
-- Legacy chatgpt-scheduled rows remain claimable so in-flight records are not stranded.
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
    AND q.source IN ('chatgpt-scheduled','opencode-actions')
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
    AND q.test_only = false AND q.source IN ('chatgpt-scheduled','opencode-actions')
    AND q.repository ~ '^AlexBDevCorner/[A-Za-z0-9_.-]+$';

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$finish$;

-- One model verdict per exact head: any existing live review row for the same
-- repository/PR/SHA (including WITHHOLD escalations) makes this a no-op (NULL).
-- MERGE_CHECK is only deduplicated against a still-pending merge check.
CREATE OR REPLACE FUNCTION review_bridge.enqueue_live_review(
  p_repository text, p_project_id text, p_task_id text, p_pr_number integer,
  p_reviewed_sha text, p_verdict text, p_findings jsonb, p_ci jsonb,
  p_review_summary text, p_observed_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $enqueue$
DECLARE inserted uuid;
BEGIN
  IF p_repository !~ '^AlexBDevCorner/[A-Za-z0-9_.-]+$'
    OR p_project_id !~ '^[a-z0-9-]+$'
    OR p_task_id !~ '^[A-Z][A-Z0-9]*-[0-9]+$'
    OR p_pr_number IS NULL OR p_pr_number < 1
    OR p_reviewed_sha !~ '^[a-f0-9]{40}$'
    OR p_verdict NOT IN ('APPROVE','REQUEST_CHANGES','WITHHOLD','MERGE_CHECK')
    OR p_findings IS NULL OR jsonb_typeof(p_findings) <> 'array'
    OR octet_length(p_findings::text) > 16000
    OR p_ci IS NULL OR jsonb_typeof(p_ci) <> 'object'
    OR p_review_summary IS NULL OR length(p_review_summary) > 4000
    OR p_observed_at IS NULL OR p_observed_at > now() + interval '5 minutes'
  THEN
    RAISE EXCEPTION 'invalid review verdict';
  END IF;

  -- Serialize concurrent enqueues of the same head before the existence check.
  PERFORM pg_advisory_xact_lock(hashtext(lower(p_repository) || '#' || p_pr_number || '@' || p_reviewed_sha));
  IF EXISTS (
    SELECT 1 FROM public.autonomous_review_queue AS q
    WHERE lower(q.repository) = lower(p_repository) AND q.pr_number = p_pr_number
      AND q.reviewed_sha = p_reviewed_sha AND q.test_only = false
      AND CASE WHEN p_verdict = 'MERGE_CHECK'
        THEN q.verdict = 'MERGE_CHECK' AND q.status IN ('queued','processing','retryable')
        ELSE q.verdict IN ('APPROVE','REQUEST_CHANGES','WITHHOLD') END
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.autonomous_review_queue (
    schema_version, source, repository, project_id, task_id, pr_number, reviewed_sha,
    verdict, findings, ci, review_summary, observed_at, test_only, status
  ) VALUES (
    1, 'opencode-actions', p_repository, p_project_id, p_task_id, p_pr_number, p_reviewed_sha,
    p_verdict, p_findings, p_ci, p_review_summary, p_observed_at, false, 'queued'
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO inserted;
  RETURN inserted;
END;
$enqueue$;

CREATE OR REPLACE FUNCTION public.review_bridge_enqueue_live_review(
  p_repository text, p_project_id text, p_task_id text, p_pr_number integer,
  p_reviewed_sha text, p_verdict text, p_findings jsonb, p_ci jsonb,
  p_review_summary text, p_observed_at timestamptz
)
RETURNS uuid
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $wrapper$
  SELECT review_bridge.enqueue_live_review(
    p_repository,p_project_id,p_task_id,p_pr_number,p_reviewed_sha,
    p_verdict,p_findings,p_ci,p_review_summary,p_observed_at
  );
$wrapper$;

REVOKE ALL ON FUNCTION review_bridge.enqueue_live_review(text,text,text,integer,text,text,jsonb,jsonb,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.review_bridge_enqueue_live_review(text,text,text,integer,text,text,jsonb,jsonb,text,timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION review_bridge.enqueue_live_review(text,text,text,integer,text,text,jsonb,jsonb,text,timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.review_bridge_enqueue_live_review(text,text,text,integer,text,text,jsonb,jsonb,text,timestamptz)
  TO service_role;
