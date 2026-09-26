# Review and merge protocol

Review autonomous PRs only at their exact current head commit. ChatGPT owns the independent code-review assessment and writes the verdict to the
Supabase review queue. The trusted default-branch GitHub Actions workflow submits
actual commit-bound GitHub reviews and performs independently guarded merges.
Deterministic code owns dispatch, retry/correction counters, and task status.

## Eligibility

Before reviewing or merging anything:

1. Read `automation/config.json`, `automation/state.json`, and the project's
   `project.yaml` from `AlexBDevCorner/AutonomousWork` master.
2. Stop if global automation is disabled, the project is not enrolled, or the
   project has `enabled: false`. The permanent automated reviewer also requires
   `automation/config.json.projects[projectId].reviewEnabled: true`.
3. Use an execution whose persisted status is `review`. A blocked execution
   may also be reviewed only when its `blockReason` is `worker_failure`, it
   already has exactly one linked open autonomous PR for that task, the PR is
   non-draft and mergeable, and every configured required CI check has succeeded
   for the current head. No other blocked reason is review-eligible.
4. The target PR must be the execution's recorded PR in the recorded target
   repository, be open and non-draft, target the configured base branch, and use
   branch `autonomous/<TASK-ID>` from that same repository. Never authorize a fork.
5. Treat autonomous labels as useful metadata, not an authorization boundary.
   Their absence alone must not block review or merge. If labels are present but
   contradict the recorded task mapping, treat that inconsistency as a blocker.
6. Read the authoritative task specification from the control repository and the
   target repository's `AGENTS.md` at the PR base. The persisted execution,
   project mapping, recorded PR number, repository, task ID and configured base
   branch are the authorization source of truth. If the PR body contains a
   `<control-repository>@<commit>: <task-path>` pin, validate it and use it as
   additional evidence. A missing PR-body pin by itself is not a blocker.

## Review

1. Record the current PR head SHA.
2. Read the full diff and relevant surrounding code. Check the task requirements
   and acceptance criteria, correctness, architecture, regressions, error
   handling, tests, scope, concurrency, and applicable security risks. Verify
   reported test evidence against GitHub CI; the PR summary is not proof.
   Follow changed dependencies outward into unchanged integration code instead
   of reviewing only touched files. In particular, when a PR adds/removes a
   project, project reference, package/dependency, solution member, executable
   entry point, generated artifact, or other build-topology input, inspect the
   repository's Dockerfiles, CI workflows, restore/publish/package manifests,
   deployment manifests and scripts, and any manually enumerated copy/restore
   inputs that can be invalidated by that change. A green solution build/test
   check is not proof that the production package/container/deployment path is
   valid. A reproducibly broken production build or deployment path is a P1
   correctness finding.
3. P0 means critical impact. P1 blocks correctness, requirements, or safe
   operation. P2 is an optional improvement. For each finding, give a concrete
   trigger and consequence and identify the affected file/line where practical.
   Never manufacture a finding merely to exercise the correction loop.
4. If the latest trusted completed review for this exact head is already
   APPROVED or CHANGES_REQUESTED, do not submit a duplicate verdict. A changed
   head ALWAYS requires a fresh review, even when the PR still shows an older
   CHANGES_REQUESTED review. Match reviews to the current head using GitHub's
   actual review `commit_id`; never infer same-head status merely from review
   existence, state, or body text. If a normalized connector response omits
   `commit_id`, MUST use the generic GitHub GET/fetch capability against
   `https://api.github.com/repos/<owner>/<repo>/pulls/<pr>/reviews` and read the
   raw review object's `commit_id` before deciding that a completed verdict
   already exists. Do not conclude that the fallback capability is unavailable
   until that exact endpoint has actually been attempted and returned an error.
   COMMENTED does not count as a completed verdict.
5. Produce REQUEST_CHANGES when any P0/P1 finding remains. Produce APPROVE
   only when no P0/P1 finding remains and every configured required check
   completed successfully for this exact head. Missing, pending, skipped,
   cancelled, or failed required checks withhold approval. Write an accurate
   structured verdict to Supabase; the workflow performs GitHub review writes.
6. Immediately before enqueuing, re-read the PR head and raw trusted reviews.
   If either changes, discard the verdict and review the new revision instead.
   The queue row must name the exact `reviewed_sha`. The workflow submits the
   GitHub review with `commit_id=reviewed_sha`, then independently verifies it.

The reviewer identity must be listed in `automation/config.json.reviewers` and
must not be the PR author. An empty reviewer list disables trusted automated
review/correction behavior.

## Guarded merge

The trusted default-branch workflow may merge an approved autonomous PR.
This action is separate from approval and must fail closed.

A merge is allowed only when all of the following still hold after a fresh
GitHub read immediately before the merge:

- the same execution is still persisted as `review`;
- global automation, project enrollment, and project `enabled` are still active;
- the same PR is still open, non-draft, and mergeable;
- repository, base branch, task ID, and `autonomous/<TASK-ID>` head branch
  still match the control state;
- the PR head SHA is exactly the reviewed SHA;
- every configured required check is completed successfully for that exact SHA;
- the latest trusted completed review for that exact SHA is APPROVED;
- there is no newer trusted completed review on that exact SHA whose state is
  CHANGES_REQUESTED.

Merge using GitHub merge method `merge` and pass the exact reviewed SHA as
`expected_head_sha`. If GitHub reports that the head moved, the PR is not
mergeable, a rule blocks the merge, or any other guard is uncertain, do not
retry by weakening the guard. Leave the PR for a later scheduled pass or human
inspection.

A trusted approval from an earlier run may be merged on a later queue event
without duplicating a review, provided every merge guard above is freshly
re-validated against current GitHub state. Enqueue MERGE_CHECK for the exact
approved head when eligible. If a normalized review-list
response omits `commit_id`, use the same raw reviews REST fallback described in
the Review section before withholding a merge.

Never implement code, change task requirements, change planning state, post
`/oc`, dispatch a worker directly, bypass branch protection, force-push, or
mark a task done. REQUEST_CHANGES is consumed by the dispatcher, which performs
bounded correction dispatch and returns an advanced head to review. This
review/correction cycle repeats until approval, the configured correction-round
limit is reached, or the developer explicitly records a machine-readable
technical disagreement for human resolution. Only the reconciler marks a task
`done` after GitHub reports the PR merged.

## Scheduled reviewer instruction

Run one scheduled ChatGPT reviewer hourly across all projects with
`projects[projectId].reviewEnabled: true`. Do not submit GitHub review or
merge mutations directly. Fetch this live protocol and relevant config/state,
project file, task spec and target AGENTS.md. Independently review at most one
eligible PR at its exact current head and verify exact-head CI and raw reviews.
If a genuine new decision is actionable, check Supabase for an existing
queued or completed verdict for the same repository/PR/SHA. Then insert
exactly one `public.autonomous_review_queue` row with
`schema_version=1`, `source=chatgpt-scheduled`, the exact enrolled
repository/project/task/PR/head mapping, `reviewed_sha`, truthful
`review_summary`, `findings`, `ci`, `observed_at`, `test_only=false`
and `status=queued`. Never fabricate P0/P1 findings or issue an approval
based solely on green CI. For an existing trusted exact-head APPROVED review,
enqueue MERGE_CHECK instead of another review. For any already completed
CHANGES_REQUESTED on the exact head, skip until the worker advances it.
On an integration failure, report it and leave the schedule enabled.
The Actions workflow independently fetches the row using the scoped queue
token, verifies all guards, submits review under the separate trusted identity,
then merges with the expected SHA using the distinct GitHub App token when
eligible. The dispatcher handles correction rounds, and the reconciler
marks work done only after confirming the actual merge.
