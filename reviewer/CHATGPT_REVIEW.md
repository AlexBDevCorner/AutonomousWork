# Review and merge protocol

Review autonomous PRs only at their exact current head commit. ChatGPT owns code
review verdicts and may perform a guarded merge after approval. Deterministic
code owns dispatch, retry/correction counters, and task status.

## Eligibility

Before reviewing or merging anything:

1. Read `automation/config.json`, `automation/state.json`, and the project's
   `project.yaml` from `AlexBDevCorner/AutonomousWork` master.
2. Stop if global automation is disabled, the project is not enrolled, or the
   project has `enabled: false`.
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
   head requires a fresh review. COMMENTED does not count as a completed verdict.
5. Otherwise submit REQUEST_CHANGES when any P0/P1 finding remains. Submit
   APPROVE only when no P0/P1 finding remains and every configured required
   check has completed successfully for this exact head. Missing, pending,
   skipped, cancelled, or failed required checks withhold approval.
6. Immediately before submitting, re-read the PR head. If it changed, discard
   the verdict and review the new revision instead. Submit with `commit_id`
   explicitly set to the reviewed SHA and include `Reviewed SHA: <sha>` in
   the review body.

The reviewer identity must be listed in `automation/config.json.reviewers` and
must not be the PR author. An empty reviewer list disables trusted automated
review/correction behavior.

## Guarded merge

An approved autonomous PR may be merged by ChatGPT. This is a separate action
from approval and must fail closed.

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

A trusted approval from an earlier scheduled run may be merged on a later run
without submitting a duplicate review, provided every merge guard above is
re-validated against the current GitHub state.

Never implement code, change task requirements, change planning state, post
`/oc`, dispatch a worker directly, bypass branch protection, force-push, or
mark a task done. REQUEST_CHANGES is consumed by the dispatcher, which performs
bounded correction dispatch. Only the reconciler marks a task `done` after
GitHub reports the PR merged.

## Scheduled reviewer and merger instruction

The normal ChatGPT scheduled task should run hourly. It should read this file
from master on every run rather than relying on a copied stale protocol.

> Each hour, manage autonomous PR review and guarded merging for
> AlexBDevCorner/AutonomousWork. Read reviewer/CHATGPT_REVIEW.md,
> automation/config.json, automation/state.json, the relevant project.yaml and
> task specification from master, then follow the repository protocol exactly.
> Act on enabled, enrolled projects with executions in review. A blocked
> execution is also review-eligible only when its block reason is
> `worker_failure` and it already has exactly one linked open autonomous PR whose
> current head is non-draft, mergeable, and green on every configured required
> CI check. Review only the exact current autonomous PR head. Treat PR labels and
> an embedded control-specification pin as optional metadata; the persisted
> execution/task/project mapping is authoritative. Validate such metadata when
> present, but do not withhold review solely because it is absent. Submit REQUEST_CHANGES for genuine
> blocking P0/P1 findings, or APPROVE only after every configured required CI
> check succeeds for that exact head. Do not duplicate an existing trusted
> completed verdict on the same head. For an exact head whose latest trusted
> completed review is APPROVED, whether approved during this run or an earlier
> run, re-read all eligibility, mapping, CI, review, mergeability and head-SHA
> guards and merge only with merge method merge and expected_head_sha set to that
> exact reviewed SHA. If any guard is missing, changed, ambiguous, or fails, do
> not merge. Never implement code, edit planning/task state, dispatch workers,
> post worker commands, or mark tasks done. Stay quiet when nothing is actionable.
> Report an authentication or missing write-capability problem as a setup failure
> rather than claiming a review or merge occurred.
