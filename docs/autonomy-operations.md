# Operating autonomous development

## Deployment order

1. Merge the reviewed AutonomousWork change first. The target worker imports its
   deterministic guards from the pinned control checkout.
2. Merge the reviewed RepoManager workflow change and let its CI run. Require the
   `build-and-test` check and a review on master through branch protection or a
   ruleset. The workflow file alone does not enforce merge protection.
3. Verify the existing GitHub App test. The dispatcher uses
   `AUTONOMOUS_APP_CLIENT_ID` and `AUTONOMOUS_APP_PRIVATE_KEY` from the control
   repository. Its installation token needs control Contents write, target
   Actions write, Pull requests read and Checks read. The dispatcher always runs
   in apply mode now, so its installation token always requests the required
   write permissions. Install it only on the participating repositories.
4. The target still uses the existing `CONTROL_REPO_TOKEN` for private control
   reads and `OPENCODE_API_KEY` for OpenCode Go. Those are not copied into files.
   Long model sessions do not hold a GitHub App installation token: those tokens
   expire too quickly for multi-hour workers. OpenCode works on the local
   `autonomous/<task-id>` branch and remote git push is disabled during the
   model step. The job-scoped `GITHUB_TOKEN` is available for repository/PR
   inspection and the bounded disagreement-comment path, but remote publication
   is owned by the workflow. After OpenCode exits (success, failure, or step
   timeout), the workflow mints a fresh GitHub App installation token, preserves
   any remaining local edits as a checkpoint, pushes the canonical task branch,
   and creates/updates the task PR. App-authenticated publication ensures PR CI
   events are emitted without depending on a token minted hours earlier.
   `CONTROL_REPO_TOKEN` and the recovery App token serve different purposes
   and must remain separate.
   Provisioning required in the target repository: `vars.AUTONOMOUS_APP_CLIENT_ID`
   plus `secrets.AUTONOMOUS_APP_PRIVATE_KEY`. The GitHub App registration and
   the RepoManager installation must both grant Contents, Pull requests, and
   Issues read/write; changing the App registration alone is not enough until the
   installation approves the updated permissions. Token minting fails closed if
   the workflow requests permissions the installation has not granted.
   Replacing the target read PAT with an installation token requires provisioning
   the App credentials in the target or an approved cross-repository token flow.
5. Run the manual RM-001 pilot. The global automatic switch can stay off. It must
   create one valid PR and pass CI. Review and merge remain manual.
6. The RM-003 lifecycle pilot proved implementation, CI, review, merge, and final
   reconciliation. Task-level authorization is now exclusively the task status:
   a Human promotes `draft` to `ready`; there is no separate per-task allowlist.
   Project enrollment in `automation/config.json` and project/global enable
   switches remain independent safety boundaries.
7. The native GitHub schedule is temporarily disabled because schedule events are not being created reliably. A ChatGPT hourly heartbeat updates `automation/dispatcher-heartbeat.txt`; a path-scoped push trigger then runs the dispatcher/reconciler in apply mode. Keep `automation/config.json.enabled` true
   only while autonomous execution is intended. The blocked-review/correction
   path still needs a dedicated bounded live fixture; never invent a finding
   against good code merely to exercise it.

## Local checks

Run each PowerShell command separately from the control repository root.

```powershell
dotnet test AutonomousWork.sln --nologo
```

```powershell
dotnet build tools/AutonomousWork.Cli -c Release --nologo
```

```powershell
node --test tools/autonomy/*.test.mjs
```

```powershell
node tools/autonomy/run.mjs --validate
```

With `GH_TOKEN` already supplied through the environment, `node
tools/autonomy/run.mjs` remains a local read-only preview command.

`--apply` is a write operation. It commits reconciliation and claims to the
configured control branch and dispatches eligible work when the global switch
allows it. The GitHub Actions dispatcher uses `--apply` for both scheduled and
manual runs. Do not run apply locally from a modified or stale checkout. Branch
updates reject a stale parent SHA.

## Status, failures and recovery

`automation/state.json` is the durable execution ledger. Each claimed task has
an ordered attempt history, unique attempt ID, initial control SHA, start time,
dispatch receipt and, once observed, run ID/URL/conclusion. Merged PRs add a merge
SHA and completion timestamp. Status and ledger writes are one Git commit.

`automation/STATUS.md` summarizes executions. The workflow also uploads
`review-queue.json`, containing PRs and exact head SHAs that need review. The
queue is advisory; the reviewer must re-read GitHub before submitting a verdict.

The retry policy is bounded but self-healing. Transient 5xx reads retry twice.
A failed/uncertain dispatch is never resent automatically because GitHub may have
accepted the non-idempotent request before the client lost the response. It waits
up to 15 minutes for a matching run, then blocks. By contrast, an observed worker
run that completed as failure/cancelled/timed-out is safe to retry with a new
claim: the reconciler automatically appends a fresh attempt, reuses the same-task
branch/PR, and preserves the failed attempt's history. Failed implementations
retry up to `maxAttempts`; failed review corrections retry up to
`maxCorrectionRounds` only while the same trusted changes-requested review,
exact PR head, open non-draft PR, and passing required CI are still present.
Any head/review change or exhausted budget stops automatic correction recovery.
Partial progress is preserved by the target workflow before the failed run ends. A correction normally must advance the PR head past
the reviewed SHA and then returns to review. The one intentional exception is an
explicit developer disagreement: the worker leaves the reviewed head unchanged
and posts a machine-readable `autonomous-review-disagreement:v1` PR comment
bound to the exact review ID and reviewed SHA. Reconciliation then blocks with
`autonomous_review_disagreement` for human resolution. An unchanged correction
without that trusted disagreement marker blocks as
`correction_did_not_advance_head`, so a consumed review ID can never deadlock
the task. Closing an unmerged PR blocks the task;
automation does not reopen it. A merge can still reconcile a blocked task to done.

Disagreement recognition accepts the authenticated PR author, matched by account
ID and login, or GitHub Actions, matched by bot account ID `41898282`, bot type,
login, and `performed_via_github_app` ID `15368` / slug `github-actions` from
GitHub's API. This supports a `github-actions[bot]` comment on an
`autonomousworkdispatcher[bot]` PR. The canonical marker and review/SHA lines must
match exactly and occur once. The comment's API and browser URLs must identify
the task PR in the target repository. Both creation and last edit must fall
within the claimed correction run. The run must match the attempt ID, configured
worker workflow, `workflow_dispatch` event, repository and default branch, with
`run_attempt: 1`. A recorded run ID cannot be replaced by another run.

GitHub API metadata authenticates the account and App. It does not identify the
individual job that posted a comment. The run/time binding relies on the target
repository's write-capable workflows being trusted: other workflows with a
write-capable `GITHUB_TOKEN` share the GitHub Actions bot identity. Protect those
workflows from untrusted code and inputs. A comment can only stop automation for
human resolution; it cannot approve a review, authorize a correction or merge.
See [GitHub's token security boundary](https://docs.github.com/en/actions/concepts/security/github_token).

`maxAttempts` counts implementation attempts **excluding** CI repairs.
Review corrections and CI repairs each have their own `maxCorrectionRounds`
budget. A verified expired OpenCode API key, failed runner setup, cancellation
or timeout is tracked as an infrastructure failure in the ledger and does not
consume those coding budgets. Unknown failures count conservatively. Repeated
infrastructure failures back off for 15, 30, 60, 120, then up to 240 minutes;
they can resume automatically after the underlying issue is fixed. When a
coding budget is exhausted, reconciliation blocks that task with a specific
reason rather than crashing the dispatcher. The operator summary includes the
task ID and separate used/maximum counts. There is no daily project-start
limit; a project may begin its next eligible task as soon as the previous one
is complete. Per-task retry limits and single-active-task guards remain.

For recovery, inspect the recorded run and PR first. Keep historical attempts;
never delete the ledger to reset counters. A blocked implementation or review correction whose latest
observed worker run ended in `failure`, `cancelled`, or `timed_out` is
normally retried on the next reconciliation pass, provided its separate
attempt budget and the relevant task/PR/review guards remain valid.
A failed correction is never converted into an implementation, and a stale
or superseded blocking review is never replayed. An explicit operator
retry remains available when needed:

```sh
node tools/autonomy/run.mjs --apply --retry RM-004
```

### Recovering an operator-resolved review dispute

`--retry` and normal reconciliation leave successful unchanged-head corrections
blocked. After a human resolves the dispute, use `--resume-correction` with the
task, current blocking review ID, exact unchanged reviewed head, and resolution
comment URL. The resolution must be a nonempty comment on that same PR, posted
after the last correction completed by a human account in `config.reviewers`.
The dispatcher pins the comment's account ID, body and edit timestamp, and
rechecks it with the PR, review and CI immediately before claiming. The queued
worker fetches it again and refuses an edited, deleted or untrusted decision.
If that worker fails and qualifies for an ordinary bounded retry, the retry
retains and revalidates the same pinned human decision.
The verified decision is included as `operatorResolution` in the worker's
`$RUNNER_TEMP/blocking-review.json` alongside the original blocking review.
Correction workers must read this evidence and the linked PR comment before
implementing the bounded resolution. The task specification remains unchanged.

For the MSS-100 incident recorded on 2026-10-31:

1. Deploy this reviewed control change to master. Observe the last worker run
   `41174909418` as completed successfully and confirm no worker is active.
   Reconciliation may refine `correction_did_not_advance_head` to
   `autonomous_review_disagreement` and record the disagreement URL; both remain
   operator-held blocked states.
2. Read [the human decision on PR #104](https://github.com/AlexBDevCorner/MtgSoloSports/pull/104#issuecomment-6545999062).
   It directs a bounded correction: keep the selection/persistence handler and
   focused tests, defer registration of the mutating Chaos field HTTP route until
   MSS-106, and verify that the route is unavailable. It does not approve PR #104.
3. Re-read GitHub. Require PR #104 to remain open and non-draft on
   `autonomous/MSS-100` from the target repository, targeting `main`, with head
   `eec31481b377e6e903656a2ee5abcd72c2608eec`, trusted `CHANGES_REQUESTED` review
   `5721484365`, passing required exact-head CI, and correction budget available.
   If any pin has changed, stop and assess the new state.
4. Preview with the command below. It makes GitHub reads and writes local summary
   files, with no remote changes. Supply `GH_TOKEN` through the existing approved
   credential mechanism; never print or paste its value.

```powershell
node tools/autonomy/run.mjs --resume-correction MSS-100 --review-id 5721484365 --expected-head eec31481b377e6e903656a2ee5abcd72c2608eec --resolution-url https://github.com/AlexBDevCorner/MtgSoloSports/pull/104#issuecomment-6545999062
```

5. After operator approval, run the dispatcher workflow on master with
   `resume_correction_task=MSS-100`, `review_id=5721484365`,
   `expected_head=eec31481b377e6e903656a2ee5abcd72c2608eec`, and
   `resolution_url=https://github.com/AlexBDevCorner/MtgSoloSports/pull/104#issuecomment-6545999062`.
   Leave `retry_task` empty. Alternatively, use the preview command with `--apply`
   from a fresh clean checkout of the current control master. Apply requires the
   global/project enable switches and commits the new claim before dispatch.
6. Check that the ledger retained every old attempt and appended a new correction
   UUID with `reason: operator_review_resolution`, the pinned decision, review and
   head. The new workflow title must contain that UUID. Never rerun the old
   Actions run, delete attempts, reset counters, edit task requirements or move
   the task to review by hand. Ambiguous dispatch receipts are observed without
   resending the same claim.
7. The correction must advance the head. Its new head must pass normal CI and
   review; the existing `CHANGES_REQUESTED` review remains effective on the old
   head. Only an observed merge allows reconciliation to mark the task done.

In GitHub Actions, run **Autonomous dispatcher and reconciler** manually and set
the optional **retry_task** input to the blocked task ID. The retry path fails
closed unless the task and execution are both blocked, the failure is an observed
completed worker run, the applicable implementation or correction attempt limit
still permits another attempt, the project/global switches are enabled,
dependencies remain done, no target worker is active, and there is no conflicting
autonomous PR. A partial open PR for an implementation retry is allowed; a
correction retry requires its original review and exact head to remain current
and required CI to be green.

A retry appends a new attempt of the same kind with a new UUID, changes
`blocked -> in_progress`, durably commits that claim before dispatch, and
preserves every previous attempt. It never re-runs the old GitHub workflow run
or reuses its claim. Non-worker blocks such as merge conflicts, closed PRs,
uncertain dispatches, and exhausted limits still require separate operator
resolution.

## Stop controls

Set `automation/config.json.enabled` to false to stop new automatic work and
corrections. Set a project's `enabled: false` to pause that project. Before a
task is claimed, a Human may also de-authorize it by changing `ready` back to
`draft`. Current worker guards re-read the global/project controls and the
pinned task specification after queueing. Already running model sessions must be
cancelled in GitHub Actions; a pause does not kill processes already past the guard.

The RepoManager worker uses `opencode-go/muse-spark-1.3-contributor` with
`variant: xhigh` by default. Its OpenCode GitHub Action is pinned to commit
`83abc64a5c4e0e0a5157f2c4435d34131009a404`; update that pin deliberately
after reviewing upstream changes rather than following `@latest`.

Scheduled dispatcher/reconciliation currently uses an hourly ChatGPT heartbeat plus a path-scoped GitHub push trigger; the native GitHub `schedule` trigger is temporarily disabled. A normal
ChatGPT scheduled task runs hourly and follows `reviewer/CHATGPT_REVIEW.md` to
review eligible autonomous PR heads and guarded-merge trusted approved heads.
The merge uses GitHub's exact `expected_head_sha` guard; the reconciler remains
the only component that marks a task `done` after observing the merge.

## Scheduled ChatGPT reviewer and merger

The hourly ChatGPT automation is intentionally separate from GitHub Actions. On
each run it re-reads `reviewer/CHATGPT_REVIEW.md` from master and treats that
file as the authoritative protocol. It may submit APPROVE or REQUEST_CHANGES and
may merge only an already trusted-approved exact head after re-validating all
current mapping, CI, review, mergeability, and SHA guards.

A successful approval is not sufficient by itself: the merge operation must use
`expected_head_sha` equal to the reviewed head. If anything changes between
review and merge, the merge fails closed and a later run re-evaluates the new
state. ChatGPT never edits planning state or marks a task complete.
