---
id: RM-000
priority: 100
status: draft
depends_on: []
---

# RM-000 — Title

<!--
How to use this template (Human role only):
1. Copy to projects/<project-id>/tasks/<NEXT-ID>.md, set front matter id to
   match the file name. IDs are globally unique across all projects.
2. Start with status: draft. Promote draft -> ready ONLY when every section
   below is filled in — draft -> ready is the human authorization boundary.
   If an authorized task must wait for another task, keep it status: ready and
   express that ordering only with depends_on. Do NOT use status: blocked solely
   because a dependency is unfinished; the dispatcher already ignores ready
   tasks until every dependency is done. Reserve blocked for exceptional
   execution/recovery states that require intervention.
3. The finished file must be self-contained: hand this file alone to OpenCode
   and it must understand what completion means. No chat context, no links
   that require guesswork.
4. Be explicit in Out of scope — agents expand tasks unless told not to.
5. Delete these HTML comments before promoting to ready.
-->

## Goal

<!-- One paragraph: what outcome does this task achieve and why? -->

## Context

<!-- Project, target repository, relevant background, links to issues/docs.
Which project does this belong to? What state is the target repo in? -->

## Requirements

<!-- Numbered, testable requirements. Each item states WHAT, not HOW.
Example:
1. The CLI validates duplicate task IDs and exits non-zero on error.
2. ... -->

## Architectural direction

<!-- Constraints and guidance for the implementer. Suggested approach,
patterns to follow, files likely involved. OpenCode may deviate only if the
Requirements and Acceptance criteria are still met — note hard constraints
with MUST. Delete this section's body if genuinely nothing to say, but keep
the heading. -->

## Acceptance criteria

<!-- Checkboxes a reviewer (ChatGPT/Human) can verify without guesswork.
Example:
- [ ] `autonomous-work validate` fails on duplicate IDs with file names listed.
- [ ] ... -->

## Verification

<!-- Exact commands and expected results. Must be runnable against the target
repository. Example:
```sh
dotnet run --project tools/AutonomousWork.Cli -- validate
``` -->

## Out of scope

<!-- Explicit non-goals. Anything listed here MUST NOT be attempted, even if
it looks like a natural follow-up — open a new draft task instead. Example:
- No changes to other projects.
- No refactoring outside the files listed above. -->
