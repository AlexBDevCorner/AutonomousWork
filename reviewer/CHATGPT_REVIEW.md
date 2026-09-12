# Review protocol

Review one autonomous PR at its current head commit. Reviewers own findings and
verdicts; deterministic code owns dispatch, counters, and task status.

1. Read `automation/config.json`. Use only enrolled projects and open PRs from
   the same target repository on `autonomous/<TASK-ID>` branches. Never review a
   fork as an authorized worker PR.
2. Read the exact `<control-repository>@<commit>: <task-path>` under the PR's
   `Control specification` section. Read the target's `AGENTS.md` at the PR base.
   Missing or contradictory requirements are blockers, not permission to invent work.
3. Record the current PR head SHA. Skip it if the designated reviewer already
   submitted APPROVED or CHANGES_REQUESTED for that SHA. A changed SHA needs a new
   review. A COMMENTED review is not a completed decision.
4. Inspect the full diff and relevant surrounding code. Check requirements,
   acceptance criteria, correctness, architecture, regressions, error handling,
   tests, scope, concurrency and applicable security risks. Verify reported test
   evidence against CI. Do not assume the agent's PR summary is proof.
5. P0 means critical impact. P1 blocks correctness, requirements or safe operation.
   P2 is an optional improvement. Include a concrete trigger, consequence, file
   and line for each finding. Do not manufacture a finding to exercise automation.
6. Submit REQUEST_CHANGES when any P0/P1 finding remains. Otherwise submit APPROVE
   only when every configured required check succeeded for the exact head being
   reviewed. Missing, pending, skipped or failed checks withhold approval.
7. Re-read the head immediately before submission. If it changed, discard the
   verdict and review the new revision. Submit with `commit_id` set explicitly
   to the reviewed SHA. Include `Reviewed SHA: <sha>` in the review body.

The reviewer must be a configured identity in `automation/config.json.reviewers`
and must not be the PR author. Start with one designated reviewer. An empty
reviewer list disables automatic correction dispatch.

Never implement code, change requirements, dispatch a worker directly, post
`/oc`, merge, or mark a task done. The reconciler reads submitted reviews and
dispatches bounded corrections using an exact review ID and head SHA. It marks
the task done only after GitHub reports the PR merged.

## Scheduled reviewer instruction

Use this prompt once a scheduled ChatGPT reviewer with GitHub **review write**
access has been configured and verified. A GitHub read connector alone is not
enough. This repository does not create a normal ChatGPT scheduled task.

> Each hour, read AlexBDevCorner/AutonomousWork's reviewer/CHATGPT_REVIEW.md and
> automation/config.json from master. Follow that protocol for enabled enrolled
> projects. Review open autonomous PRs only when their current head SHA has not
> already received a completed review from your configured identity. Use the
> pinned task specification and target AGENTS.md. Submit a review against that
> exact commit, with REQUEST_CHANGES for P0/P1 findings or APPROVE only after the
> required CI checks pass. Never implement, merge, edit planning state, or post
> worker commands. Stay quiet when no new eligible head requires review. Report
> authentication or missing write capability as a setup failure instead of
> claiming a review was submitted.
