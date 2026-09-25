# Step 4: controlled fixture review submission

**Status:** implementation staged, **no production review writes**. Step 3 remains
the active mandatory-dry-run Supabase receiver. This step introduces a
separate, manually invoked review test against exactly one disposable PR
in the **AutonomousWork** repository. It cannot post reviews to MtgSoloSports,
RepoManager or MandarinBotNet; it cannot merge or dispatch workers.

## What is being tested

GitHub must accept a review from the separately configured trusted
`AlexBDevCorner` account on a disposable PR authored by the
`autonomousworkdispatcher[bot]` GitHub App. This proves identity
separation and exact GitHub REST `commit_id` handling before allowing any
non-test queue record in later iterations.

The disposable PR touches **only**
`docs/review-bridge-fixtures/step4.md` on branch
`review-bridge-fixture/step4`. It declares `fixture_id: step4`. The
repository's real, independent `fixture-validation` CI check requires
`fixture_status: ready`.

The App first creates the fixture with `fixture_status: broken`.
`fixture-validation` should genuinely FAIL for a documented,
reproducible defect; the regular `validate` check should succeed.
Only then does a manually invoked reviewer submit an actual
`REQUEST_CHANGES` review on that exact commit. A separately invoked App
repair commits `fixture_status: ready`, advancing the PR head. Both
checks must then pass before a **new exact-head** `APPROVE` review.
Do **not** fabricate findings on a healthy production PR.

This is a narrow identity/API test; the production Supabase bridge is
still dry-run-only. The disposable fixture is NOT an enrolled autonomous
task. Real dispatcher correction-loop integration remains independently
guarded and is not switched on by this fixture test.

## Operator setup

Only start after the implementation PR has passed CI and merged to
`master`.

1. Check that `AUTONOMOUS_APP_CLIENT_ID` (GitHub variable) and
   `AUTONOMOUS_APP_PRIVATE_KEY` (GitHub secret) still exist. The fixture
   creation workflow requests a short-lived App installation token for
   **AutonomousWork only**, with **Contents: write** and
   **Pull requests: write**. The existing App may currently have only
   PR read permission. If GitHub refuses this request, update the App's
   installation permissions and approve the change. Do not substitute
   the human review token to create the fixture: the author and reviewer
   must be different users. This workflow is operator-triggered; it
   does not alter any production task or control-state files.
2. Create a **fine-grained personal access token** on the
   `AlexBDevCorner` account. Resource owner:
   `AlexBDevCorner`; repository access: **Only selected repositories →
   AutonomousWork**; repository permissions: **Pull requests: Read and
   write** (GitHub includes read access). Use a short expiration date,
   e.g. seven days, for this temporary proof. Name it
   `review-bridge-step4-fixture`.
3. Store the new token in **AutonomousWork → Settings → Secrets and
   variables → Actions → Secrets → New repository secret**, under the
   exact name `REVIEW_BRIDGE_REVIEWER_TOKEN`. Never use the existing
   GitHub dispatch token or the Supabase queue token as a reviewer.
4. **Do not enable writes until the fixture exists and the tests are
   green.** The separate GitHub Actions variable
   `REVIEW_BRIDGE_FIXTURE_WRITE_ENABLED` must be `true` before running
   a real fixture review. It is independent of
   `REVIEW_BRIDGE_STEP3_ENABLED`, which stays `true`.

## Controlled exercise

1. Actions → **Step 4 disposable fixture PR (operator only)** →
   **Run workflow** from `master`:
   - phase: `create`
   - pr_number: leave blank
   - confirmation: `CREATE_STEP4_FIXTURE`

   Its GitHub App token creates branch
   `review-bridge-fixture/step4`, the single broken file and a
   non-draft PR whose body includes the fixture marker. Save the exact
   PR number and SHA from the run summary or the PR's Commits tab.
   Never merge this PR.

2. Wait for `validate` to succeed and `fixture-validation` to fail
   for the SAME PR head. If another check fails, inspect the cause;
   do not force an approval or bypass the check. A synthetic failure
   in an unrelated production file is not an acceptable substitute.

3. Actions → **Step 4 controlled fixture review (operator only)** →
   **Run workflow** from `master`:
   - pr_number: fixture PR number
   - expected_sha: exact 40-character head SHA
   - event: `VERIFY_ONLY`
   - confirmation: leave empty

   Review the job output. It must report `inspected` and the broken
   fixture plus the failed validation. This mode has **no write**.

4. Set the GitHub Actions **variable**
   `REVIEW_BRIDGE_FIXTURE_WRITE_ENABLED=true`. In the same manual
   review workflow, pass the **same PR and head SHA**, choose
   `REQUEST_CHANGES` and enter the literal confirmation
   `STEP4_FIXTURE_ONLY`. It will reread live `master`, verify trusted
   reviewer token identity via `GET /user`, verify the PR's worker-App
   author / exact branch / allowlisted file, verify the failing
   `fixture-validation` check, verify no same-head completed trusted
   review, reread all guards, and only then POST a review using
   `commit_id=<expected_sha>`.

   GitHub's returned review must have `state=CHANGES_REQUESTED`,
   `user.login=AlexBDevCorner`, and **exact** `commit_id`.
   The workflow re-reads raw reviews to confirm the same review ID,
   identity, state and SHA. A repeated run must be a no-op.

5. Actions → **Step 4 disposable fixture PR (operator only)** →
   **Run workflow** on `master`:
   - phase: `repair`
   - pr_number: the same fixture PR number
   - confirmation: `REPAIR_STEP4_FIXTURE`

   The worker App independently verifies the genuine old-head
   `CHANGES_REQUESTED` review and fixes the same single fixture file,
   advancing the HEAD SHA. It does **not** run the production
   dispatcher. Wait for `validate` and `fixture-validation` to
   complete successfully on the *new* SHA.

6. Run the controlled fixture review workflow with the **new** SHA,
   `APPROVE`, and the same confirmation `STEP4_FIXTURE_ONLY`.
   Its independent, latest-head checks must pass. The returned and
   raw re-fetched review must have `state=APPROVED`,
   `user.login=AlexBDevCorner` and `commit_id=<new SHA>`.
   The older `CHANGES_REQUESTED` is on a *different* commit and cannot
   block this legitimate new review. A repeat must not submit a
   duplicate. No workflow has any PR merge endpoint.

7. Disable `REVIEW_BRIDGE_FIXTURE_WRITE_ENABLED` (set `false`),
   **delete the temporary `REVIEW_BRIDGE_REVIEWER_TOKEN`** from
   GitHub after testing, and **close the disposable PR without merging**.
   The fixture branch can be deleted once evidence is saved. Don't
   enable production reviews yet: that needs subsequent gates.

## Failure and safety semantics

- An ambiguous POST response (network timeout) is **not** retried.
  Inspect the raw GitHub reviews on the exact SHA before a manual
  retry. A later run skips an already completed trusted same-head
  verdict.
- A changed head or `master`, changed author/branch, extra changed
  files, missing/failed required approval checks, or incorrect reviewer
  token causes a hard stop. A review explicitly names its commit SHA.
  A concurrent new PR commit cannot turn an old-head approval into
  approval for the new revision.
- If the GitHub App cannot obtain `permission-pull-requests: write`,
  stop and adjust App installation permissions rather than borrowing
  the reviewer PAT for PR creation.
- The manual review workflow has **no queue token** or Supabase DB key.
  Its only write-capable credential is the separate trusted reviewer
  PAT, scoped to the single repository and available only to this
  operator-invoked fixture workflow.
- `review-bridge.yml`, `review-bridge-queue`, Step 3 SQL functions and
  the existing dispatcher/reconciler remain unchanged. The normal
  queue rejects `test_only=false` throughout Step 4.

The next stages must integrate these proven, exact-head write primitives
with independently checked non-test queue claims and then separate,
guarded merges. This fixture result is never production authorization.
