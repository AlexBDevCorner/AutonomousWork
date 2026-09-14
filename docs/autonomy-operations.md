# Operating the pilot

## Deployment order

1. Merge the reviewed AutonomousWork change first. The target worker imports its
   deterministic guards from the pinned control checkout.
2. Merge the reviewed RepoManager workflow change and let its CI run. Require the
   `build-and-test` check and a review on master through branch protection or a
   ruleset. The workflow file alone does not enforce merge protection.
3. Verify the existing GitHub App test. The dispatcher uses
   `AUTONOMOUS_APP_CLIENT_ID` and `AUTONOMOUS_APP_PRIVATE_KEY` from the control
   repository. Its installation token needs control Contents write, target
   Actions write, Pull requests read and Checks read. Preview requests read
   permissions only. Install it only on the participating repositories.
4. The target still uses the existing `CONTROL_REPO_TOKEN` for private control
   reads and `OPENCODE_API_KEY` for OpenCode Go. Those are not copied into files.
   GitHub authentication for the worker itself is a short-lived GitHub App
   installation token minted in the run and supplied explicitly to the OpenCode
   step with `use_github_token: true` (as both `GITHUB_TOKEN` and `GH_TOKEN`
   for `gh`); no OIDC is required. The built-in `GITHUB_TOKEN` is deliberately
   not used for the OpenCode step: PRs it creates would leave `pull_request` CI
   approval-required and stall unattended autonomy, while an App token lets CI
   run automatically.
   `CONTROL_REPO_TOKEN` and the worker App token serve different purposes
   and must remain separate.
   Provisioning required in the target repository: `vars.AUTONOMOUS_APP_CLIENT_ID`
   plus `secrets.AUTONOMOUS_APP_PRIVATE_KEY`, with the App installation on
   RepoManager granting Contents, Pull requests, and Issues write. If the
   installation currently grants less, update the App permissions and reinstall
   before running the worker; token minting fails closed otherwise.
   Replacing the target read PAT with an installation token requires provisioning
   the App credentials in the target or an approved cross-repository token flow.
5. Run the manual RM-001 pilot. The global automatic switch can stay off. It must
   create one valid PR and pass CI. Review and merge remain manual.
6. Resolve the RM-002 conflict and authorize a lifecycle pilot task. Add only its
   ID to the allowlist. Configure the designated reviewer identity and prove it
   can submit reviews. Test the blocked-review path using an actual bounded
   fixture, never an invented finding against good code.
7. Set `automation/config.json.enabled` to true after those checks. Run dispatcher
   preview, inspect its selected task, then run apply. Add a 15-30 minute schedule
   only after the full implementation/review/correction/merge lifecycle works.

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

With `GH_TOKEN` already supplied through the environment, this reads GitHub and
writes only local status/queue output. It never dispatches or changes GitHub.

```powershell
node tools/autonomy/run.mjs
```

`--apply` is a write operation. It commits reconciliation and claims to the
configured control branch and dispatches eligible work when the global switch
allows it. Use the manual Actions workflow for this operation. Do not run apply
from a modified or stale checkout. Branch updates reject a stale parent SHA.

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
it produced a partial PR. A correction that succeeds without advancing the PR
head past the reviewed SHA fails verification and reconciles to
`correction_did_not_advance_head` instead of returning to review, so a consumed
review ID can never deadlock the task. Closing an unmerged PR blocks the task;
automation does not reopen it. A merge can still reconcile a blocked task to done.
Manual pilot attempts are bounded by `maxAttempts` (three permits three manual
model executions).

For recovery, inspect the recorded run and PR first. Reconcile the task status
and corresponding execution record together in a reviewed operator commit.
Keep historical attempts; do not delete the ledger to reset counters. Automatic
retry of blocked executions is not implemented. The worker refuses re-running
the same GitHub run or dispatching the same claim a second time.

## Stop controls

Set `automation/config.json.enabled` to false to stop new automatic work and
corrections. Set a project's `enabled: false` to pause it, or remove an unstarted
task from its allowlist. Current worker guards also re-read these controls after
queueing. Already running model sessions must be cancelled in GitHub Actions;
a pause does not kill processes already past the guard.

Scheduled dispatch and the normal ChatGPT reviewer are not enabled by this
change. No automatic merge path exists.
