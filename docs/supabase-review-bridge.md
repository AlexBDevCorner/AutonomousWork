# Supabase-backed autonomous PR review bridge

Status: design, **not enabled for production**. Owner: AutonomousWork. Base: `master`.

## Why this exists

The ChatGPT scheduled reviewer can read GitHub PRs but its direct GitHub review/merge writes have been blocked in scheduled execution. Seven independent scheduled Supabase insert canaries succeeded. Keep code-review judgment in ChatGPT and move GitHub mutation to a small deterministic GitHub Actions processor. Do not weaken the existing review and merge protocol.

Source of truth: `reviewer/CHATGPT_REVIEW.md`, `automation/config.json`, `automation/state.json`, the enrolled `projects/*/project.yaml` and task specs on `master`, and the actual current GitHub PR/CI state. Supabase is a **delivery queue and audit record, not an authorization source**.

## Existing environment as inspected September 25, 2026

- Supabase project `ayewunekctfmdxgjtqfl` already contains `public.autonomous_review_queue` (empty) and `public.connector_test`. The queue has RLS enabled, no public/authenticated table grants or RLS policies, and service-role table grants; do not add broad public policies to solve connector problems.
- The existing queue has UUID id, schema_version, source, repository, project_id, task_id, pr_number, reviewed_sha, verdict, findings, ci, review_summary, observed_at, test_only (defaults true), status, attempts, claim/lease timestamps, GitHub review/merge results, error, and creation/update timestamps. It has an index for the queue and a unique live APPROVE/REQUEST_CHANGES verdict per lowercased repository + PR + reviewed SHA. Verify all constraints and import its existing migration into source control instead of creating a duplicate database table.
- No database webhook/trigger exists yet on the queue.
- The active control protocol lists `AlexBDevCorner` as a trusted reviewer. Existing target PRs are authored by the separate autonomous worker App. Preserve the separation; an App must not approve its own PR.
- Existing dispatcher/reconciler owns worker dispatch, correction limits and marking merged tasks done. The reviewers and canary test tasks were paused; keep them paused until the indicated rollout gates.

## Target flow

1. A scheduled ChatGPT reviewer reads the live control protocol/config/state and relevant GitHub code, full diff, dependencies and exact-head required CI. If there is an eligible actionable PR, it inserts **one** structured queue record with reviewed_sha, verdict, findings and supporting summary. Before insert, re-read PR head and drop any stale verdict. No GitHub writes.
2. An INSERT-only Supabase database webhook calls a secured Edge Function. The function validates event shape and source and sends only the UUID as a `repository_dispatch` event to `AutonomousWork`. Keep the GitHub dispatch credential in Supabase secrets, never in the database, repository or event payload. This event is a notification, not an approval.
3. A new default-branch `review-bridge.yml` GitHub Action retrieves the row by ID using an appropriately scoped Supabase secret, atomically claims it, and rejects duplicates or stale/expired claims. Do not run untrusted PR-head code with credentials.
4. The deterministic processor re-reads **current** `master` configuration/state, project and task specs, and GitHub PR/CI/review facts. It validates enabled/enrolled project, execution status and narrow worker_failure exception, recorded repo/task/PR mapping, same-repo autonomous branch, configured base, non-draft/open/mergeability, exact reviewed SHA, and required `build-and-test` success for approval. Labels are advisory; contradictory labels block. Never accept the row's `source` or verdict alone as proof of identity or authorization.
5. In `test_only=true`, the processor **never** posts reviews or merges; it records its validation result as `dry_run`, `stale`, `withheld` or `failed`.
6. Once individually enabled after testing, submit GitHub `REQUEST_CHANGES` only for actual P0/P1 findings, or `APPROVE` only when no P0/P1 remains and all required checks passed. Explicitly bind review `commit_id` to the exact reviewed SHA. Compare GitHub reviews using raw `commit_id`, including the protocol's raw REST fallback. Suppress an already completed trusted same-head verdict; re-review any new head.
7. A merge is **separate**. Verify the fresh latest trusted completed exact-head review is APPROVED and all merge guards still hold. Merge only with method `merge` and `expected_head_sha=reviewed_sha`. A MERGE_CHECK record may request re-evaluation, but never creates or implies approval. Let the existing reconciler observe the merge and mark `done`. `REQUEST_CHANGES` feeds the existing bounded correction loop; do not dispatch the worker directly.

## Identity and credentials

- Use a tightly scoped GitHub credential in the Supabase Edge Function to dispatch **only** the control repo workflow.
- Use existing worker/dispatcher GitHub App identity where its permissions suffice for GitHub reads and permitted merges.
- For actual GitHub reviews, use a separate trusted reviewer identity that GitHub allows to approve PRs authored by the worker; start with the configured `AlexBDevCorner` reviewer if a restricted token and branch protection allow it. Confirm exact GitHub permission requirements in a controlled test before enabling writes.
- Store reviewer and Supabase backend keys exclusively in GitHub Actions secrets. Avoid printing them or passing them into untrusted PR code. RLS and no public policies are intentionally restrictive; only privileged scheduled connector access and secret-bearing trusted services should write/read the queue.

## Iterations and acceptance gates

**0. Document and audit (this PR).** Confirm current schema/indexes/RLS/grants/triggers, current reviewer protocol and operator safety controls. No production mutation.

**1. Structured queue record.** Use the existing table and insert one realistic `test_only=true` WITHHOLD fixture via the same Supabase connector the scheduled reviewer uses. Read it back by UUID and verify metadata, findings and timestamps. Record the existing SQL migration in the repo through the supported Supabase migration workflow; do not blindly replay it.

**2. Delivery-only bridge.** Create the secured Edge Function + INSERT webhook + GitHub `repository_dispatch` workflow. A test row triggers a run that fetches the *same* UUID, revalidates its shape and acknowledges it as `dry_run`. No GitHub PR mutation. Confirm webhook errors and read-back.

**3. Deterministic processor.** Implement the guard-checking and idempotency module with tests for duplicate deliveries, mismatched repo/task/branch, disabled controls, pending/failing CI, stale SHA, failed leases, pre-existing same-head reviews and missing credentials. Start in mandatory dry-run mode.

**4. Controlled review action.** Configure separate reviewer credentials and execute first review on a disposable eligible fixture PR. Verify GitHub returned review `commit_id` equals the submitted SHA. Test genuine REQUEST_CHANGES and correction handling without fabricating findings against good code.

**5. Controlled guarded merge.** Use a disposable fixture to test an existing trusted exact-head approval, negative guards, the exact expected SHA merge, callback failure/retry, and existing reconciliation. Do not allow an external queue record to skip review verification.

**6. Schedule cutover.** Replace five paused direct-write reviewer prompts with Supabase-only output prompts, retaining live protocol reads. Begin with one reviewer in test-only mode, then enable the remaining four. Retain the original reviewers disabled as rollback backups. Enable non-test review and then merge only after independent negative and success tests pass.

## Recovery and observability

The queue's status, attempts, timestamps, errors and GitHub result identifiers form the audit trail. Treat webhook delivery as at-least-once: lease/claim rows atomically and make GitHub actions idempotent by checking live review/merge state **before** every retry. Start with an operator-invoked recovery workflow; add periodic recovery after delivery reliability is demonstrated (GitHub's existing native schedules have been unreliable here). Never automatically re-send an uncertain merge or an uncertain worker dispatch. Report exact errors without bypassing the guards.

## Non-goals for the first iterations

No replacement of the current dispatcher/reconciler, no generic agent executor or approval based solely on Supabase contents, no live PR merge during connectivity testing, and no secret provisioning inside ChatGPT or committed source files.
