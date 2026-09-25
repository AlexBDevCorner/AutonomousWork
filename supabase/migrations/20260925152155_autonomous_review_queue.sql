-- Reviewed with Supabase RLS enabled. No webhook or GitHub write is activated by this migration.
CREATE TABLE IF NOT EXISTS public.autonomous_review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  source text NOT NULL DEFAULT 'chatgpt-scheduled',
  repository text NOT NULL CHECK (repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  project_id text NOT NULL CHECK (project_id ~ '^[a-z0-9-]+$'),
  task_id text NOT NULL CHECK (task_id ~ '^[A-Z][A-Z0-9]*-[0-9]+$'),
  pr_number integer NOT NULL CHECK (pr_number > 0),
  reviewed_sha text NOT NULL CHECK (reviewed_sha ~ '^[0-9a-f]{40}$'),
  verdict text NOT NULL CHECK (verdict IN ('APPROVE', 'REQUEST_CHANGES', 'WITHHOLD', 'MERGE_CHECK')),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  ci jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(ci) = 'object'),
  review_summary text NOT NULL DEFAULT '',
  observed_at timestamptz NOT NULL DEFAULT now(),
  test_only boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'applied', 'dry_run', 'stale', 'withheld', 'retryable', 'failed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 4),
  claimed_at timestamptz,
  lease_until timestamptz,
  github_review_id bigint,
  merge_sha text CHECK (merge_sha IS NULL OR merge_sha ~ '^[0-9a-f]{40}$'),
  last_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Do not accept competing live completed verdicts for the same exact head.
CREATE UNIQUE INDEX IF NOT EXISTS autonomous_review_one_live_verdict
  ON public.autonomous_review_queue (lower(repository), pr_number, reviewed_sha)
  WHERE test_only = false AND verdict IN ('APPROVE', 'REQUEST_CHANGES');

CREATE INDEX IF NOT EXISTS autonomous_review_retry_queue
  ON public.autonomous_review_queue (status, created_at)
  WHERE status IN ('queued', 'retryable', 'processing');

ALTER TABLE public.autonomous_review_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.autonomous_review_queue FROM PUBLIC, anon, authenticated;
-- The connected administrative Supabase plugin and server-side service_role can write;
-- no anon/authenticated policy is intentionally created.

CREATE OR REPLACE FUNCTION public.claim_autonomous_review(p_id uuid)
RETURNS SETOF public.autonomous_review_queue
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $function$
  UPDATE public.autonomous_review_queue
  SET status = 'processing',
      attempts = attempts + 1,
      claimed_at = now(),
      lease_until = now() + interval '30 minutes',
      updated_at = now(),
      last_error = NULL
  WHERE id = p_id
    AND attempts < 4
    AND (
      status IN ('queued', 'retryable')
      OR (status = 'processing' AND lease_until < now())
    )
  RETURNING *;
$function$;
REVOKE ALL ON FUNCTION public.claim_autonomous_review(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_autonomous_review(uuid) TO service_role;
