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
   GitHub authentication for the worker itself is a short-lived GitHub App
   installation token minted in the run and supplied explicitly to the OpenCode
   step with `use_github_token: true` (as both `GITHUB_TOKEN` and `GH_TOKEN`
   for `gh`); no OIDC is required. The same token is wired into git through
   the GitHub CLI credential helper (`gh auth setup-git`) by the workflow, so
   ordinary `git push` works without persisting the raw token. The built-in
   `GITHUB_TOKEN` is deliberately
   not used for the OpenCode step: PRs it creates would leave `pull_request` CI
   approval-required and stall unattended autonomy, while an App token lets CI
   run automatically.
   `CONTROL_REPO_TOKEN` and the worker App token serve different purposes
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

The current retry policy is intentionally conservative. Transient 5xx reads
retry twice. A failed/uncertain dispatch is never resent automatically. It waits
up to 15 minutes for a matching run, then blocks. A failed worker blocks even if
it produced a partial PR. A correction normally must advance the PR head past
the reviewed SHA and then returns to review. The one intentional exception is an
explicit developer disagreement: the worker leaves the reviewed head unchanged
and posts a machine-readable `autonomous-review-disagreement:v1` PR comment
bound to the exact review ID and reviewed SHA. Reconciliation then blocks with
`autonomous_review_disagreement` for human resolution. An unchanged correction
without that trusted disagreement marker blocks as
`correction_did_not_advance_head`, so a consumed review ID can never deadlock
the task. Closing an unmerged PR blocks the task;
automation does not reopen it. A merge can still reconcile a blocked task to done.
`maxAttempts` bounds implementation attempts per task, and `maxCorrectionRounds`
bounds review fixes and CI repairs per task. There is no daily project-start
limit; a project may begin its next eligible task as soon as the previous one
is complete. Per-task retry limits and single-active-task guards remain.

For recovery, inspect the recorded run and PR first. Keep historical attempts;
never delete the ledger to reset counters. A blocked implementation whose latest
observed worker run ended in `failure`, `cancelled`, or `timed_out` can be
retried only by an explicit operator request:

```sh
node tools/autonomy/run.mjs --apply --retry RM-004
```

In GitHub Actions, run **Autonomous dispatcher and reconciler** manually and set
the optional **retry_task** input to the blocked task ID. The retry path fails
closed unless the task and execution are both blocked, the failure is an observed
completed worker run, the implementation-attempt limit still
permits another attempt, the project/global switches are enabled, dependencies
remain done, no target worker is active, and there is no conflicting autonomous
PR. A partial open PR for the same task is allowed and is reused by the worker.

A retry appends a new implementation attempt with a new UUID, changes
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
