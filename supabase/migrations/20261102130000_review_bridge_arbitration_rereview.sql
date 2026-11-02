-- Same-SHA re-review after binding arbitration (#35). A verdict may supersede the
-- trusted review whose disputed finding the arbiter overturned; the bridge accepts it
-- only when the control ledger records that decision for that exact review and head.
-- One live verdict per (repository, PR, head, superseded review) is still enforced.
ALTER TABLE public.autonomous_review_queue
  ADD COLUMN IF NOT EXISTS supersedes_review_id bigint
  CHECK (supersedes_review_id IS NULL OR supersedes_review_id > 0);

DROP INDEX IF EXISTS public.autonomous_review_one_live_verdict;
CREATE UNIQUE INDEX autonomous_review_one_live_verdict
  ON public.autonomous_review_queue (lower(repository), pr_number, reviewed_sha, coalesce(supersedes_review_id, 0))
  WHERE test_only = false AND verdict IN ('APPROVE', 'REQUEST_CHANGES');

-- The signature changes; drop rather than overload so PostgREST resolves one function.
DROP FUNCTION IF EXISTS public.review_bridge_enqueue_live_review(text,text,text,integer,text,text,jsonb,jsonb,text,timestamptz);
DROP FUNCTION IF EXISTS review_bridge.enqueue_live_review(text,text,text,integer,text,text,jsonb,jsonb,text,timestamptz);

CREATE FUNCTION review_bridge.enqueue_live_review(
  p_repository text, p_project_id text, p_task_id text, p_pr_number integer,
  p_reviewed_sha text, p_verdict text, p_findings jsonb, p_ci jsonb,
  p_review_summary text, p_observed_at timestamptz, p_supersedes_review_id bigint DEFAULT NULL
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
    OR (p_supersedes_review_id IS NOT NULL AND (p_supersedes_review_id < 1 OR p_verdict = 'MERGE_CHECK'))
    OR p_findings IS NULL OR jsonb_typeof(p_findings) <> 'array'
    OR octet_length(p_findings::text) > 16000
    OR p_ci IS NULL OR jsonb_typeof(p_ci) <> 'object'
    OR p_review_summary IS NULL OR length(p_review_summary) > 4000
    OR p_observed_at IS NULL OR p_observed_at > now() + interval '5 minutes'
  THEN
    RAISE EXCEPTION 'invalid review verdict';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(lower(p_repository) || '#' || p_pr_number || '@' || p_reviewed_sha));
  IF EXISTS (
    SELECT 1 FROM public.autonomous_review_queue AS q
    WHERE lower(q.repository) = lower(p_repository) AND q.pr_number = p_pr_number
      AND q.reviewed_sha = p_reviewed_sha AND q.test_only = false
      AND CASE WHEN p_verdict = 'MERGE_CHECK'
        THEN q.verdict = 'MERGE_CHECK' AND q.status IN ('queued','processing','retryable')
        ELSE q.verdict IN ('APPROVE','REQUEST_CHANGES','WITHHOLD')
          AND q.supersedes_review_id IS NOT DISTINCT FROM p_supersedes_review_id END
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.autonomous_review_queue (
    schema_version, source, repository, project_id, task_id, pr_number, reviewed_sha,
    verdict, findings, ci, review_summary, observed_at, test_only, status, supersedes_review_id
  ) VALUES (
    1, 'opencode-actions', p_repository, p_project_id, p_task_id, p_pr_number, p_reviewed_sha,
    p_verdict, p_findings, p_ci, p_review_summary, p_observed_at, false, 'queued', p_supersedes_review_id
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO inserted;
  RETURN inserted;
END;
$enqueue$;

CREATE FUNCTION public.review_bridge_enqueue_live_review(
  p_repository text, p_project_id text, p_task_id text, p_pr_number integer,
  p_reviewed_sha text, p_verdict text, p_findings jsonb, p_ci jsonb,
  p_review_summary text, p_observed_at timestamptz, p_supersedes_review_id bigint DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $wrapper$
  SELECT review_bridge.enqueue_live_review(
    p_repository,p_project_id,p_task_id,p_pr_number,p_reviewed_sha,
    p_verdict,p_findings,p_ci,p_review_summary,p_observed_at,p_supersedes_review_id
  );
$wrapper$;

REVOKE ALL ON FUNCTION review_bridge.enqueue_live_review(text,text,text,integer,text,text,jsonb,jsonb,text,timestamptz,bigint)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.review_bridge_enqueue_live_review(text,text,text,integer,text,text,jsonb,jsonb,text,timestamptz,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION review_bridge.enqueue_live_review(text,text,text,integer,text,text,jsonb,jsonb,text,timestamptz,bigint)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.review_bridge_enqueue_live_review(text,text,text,integer,text,text,jsonb,jsonb,text,timestamptz,bigint)
  TO service_role;
