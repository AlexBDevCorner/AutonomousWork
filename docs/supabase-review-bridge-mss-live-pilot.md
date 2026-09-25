# Direct live pilot: MtgSoloSports only

We skipped another disposable fixture. The first real target is the currently
review-eligible MSS-002 pull request in AlexBDevCorner/MtgSoloSports.
Do not treat this as enabling RepoManager or MandarinBotNet.
The existing test-only Step 3 path, reviewer rules, and autonomous dispatcher
remain available. The live pilot has an independent opt-in variable.

## Flow

1. An hourly ChatGPT reviewer reads the live reviewer protocol, config,
   state, project.yaml, task spec, target AGENTS.md, full relevant changes,
   surrounding code, exact-head CI and raw reviews. It makes an actual code
   review and never invents a defect or treats green CI as proof of quality.
2. A genuine new verdict inserts exactly one Supabase
   public.autonomous_review_queue row with test_only=false and
   source=chatgpt-scheduled, exact repository/project/task/PR/head mapping,
   truthful review_summary, ci and findings. A previously approved exact
   head should produce MERGE_CHECK rather than a duplicate review.
3. The existing INSERT webhook sends only the UUID via a separate MSS
   event. The GitHub Actions pilot job requires an explicit opt-in
   variable. The Edge Function and SQL RPCs restrict all pilot rows to
   the exact MtgSoloSports repository and project.
4. The runner independently validates control state, task requirements
   and protocol, recorded execution, PR branch and author, required
   exact-head CI and raw reviews. It repeats the guards before submitting
   the actual SHA-bound review through the separate human PAT.
5. REQUEST_CHANGES is picked up by the existing scheduled autonomous
   dispatcher. The worker corrects and advances the PR head, then a
   future scheduled reviewer assesses the new revision.
6. APPROVE causes a fresh independent MERGE_CHECK. If eligible, the
   separately scoped worker App token merges the PR with the exact head
   SHA; the existing reconciler later marks the task done.
7. Duplicate deliveries are no-ops; uncertain GitHub writes are
   inspected before resuming. SQL leases have a maximum of 4 attempts.

No real review is fabricated from CI or queue metadata.

## Required one-time operator setup

1. Add a fine-grained PAT owned by AlexBDevCorner, limited to
   MtgSoloSports with Pull requests: Read and write, as AutonomousWork
   GitHub Actions secret REVIEW_BRIDGE_PILOT_REVIEWER_TOKEN.
   You may add MtgSoloSports to the previous PAT if desired.
2. Merge this implementation PR after CI. Keep both
   REVIEW_BRIDGE_MSS_PILOT_ENABLED and
   REVIEW_BRIDGE_FIXTURE_WRITE_ENABLED disabled during setup.
   Keep REVIEW_BRIDGE_STEP3_ENABLED=true and preserve
   REVIEW_BRIDGE_QUEUE_TOKEN; the old privileged GitHub key was
   intentionally deleted after successful Step 3 tests.
3. Apply supabase/migrations/20260926010000_review_bridge_mss_live_pilot.sql
   once to Supabase project ayewunekctfmdxgjtqfl. Deploy Edge Functions
   review-bridge-queue and review-bridge-dispatch from the merged code.
   Their existing Edge secrets remain in Supabase (the privileged DB
   key must never be copied into GitHub).
4. Once both deployments and SQL complete, set AutonomousWork GitHub
   Actions variable REVIEW_BRIDGE_MSS_PILOT_ENABLED=true. The existing
   AUTONOMOUS_APP_CLIENT_ID variable and AUTONOMOUS_APP_PRIVATE_KEY
   secret must be valid for the worker App installed on MtgSoloSports
   with Contents: write and Pull requests: write.
5. Enable only the new MSS-to-Supabase scheduled reviewer. Keep the old
   recreated direct-GitHub reviewers paused so they cannot race.

## Manual recovery of an existing queued/retryable UUID

AutonomousWork Actions > Supabase review delivery
(dry run + isolated MSS live pilot) > Run workflow from master:
queue_id = existing queue UUID, mode = pilot.

Always inspect the prior Actions run and actual GitHub reviews before
recovering an ambiguous POST. Never create a second approval verdict
for the same repo/PR/head; a partial unique index prevents it.

Read-only Supabase investigation query:

~~~sql
select id, repository, task_id, pr_number, reviewed_sha, verdict,
       status, attempts, github_review_id, merge_sha, last_error,
       validation_result, created_at, processed_at
from public.autonomous_review_queue
where test_only = false and project_id = 'mtgsolosports'
order by created_at desc
limit 12;
~~~

Kill switch: set REVIEW_BRIDGE_MSS_PILOT_ENABLED=false.
This leaves the existing test-only Step 3 path and dispatcher intact;
it cannot undo an earlier accepted GitHub review or merge.
