<!--
Before you open this: `npm test`, and `git ls-files '*.js' | xargs -n1 -P4 node
--check`. Those are the two things CI runs that a laptop can run too; this repo
has no formatter or linter step to run first.

The title is a Conventional Commit — feat, fix, refactor, test, docs or chore,
optionally scoped after what it touches: `feat(db_maintenance):`, `fix(api):`.

The shape below is checked by .github/workflows/pr_body.yml. Ask it about a
draft before you open one:

    node scripts/check_pr_body.js draft.md

Each paragraph on ONE long line. GitHub renders a single newline in a pull
request body as a line break, so prose wrapped at 72 or 80 columns comes out
ragged at every window width. Wrapping stays right in commit messages and in
.md files in the repo. Lists, tables and fenced code blocks are unaffected.

Everything above the `---` is for a reviewer deciding whether to read the diff,
so it is natural language: no file paths, no symbol names, no code. Artifact is
the exception and is meant to carry them, because it is evidence.
-->

> **Human TL;DR pending:** PR author, replace this line with your one-sentence summary before review.

## Summary

<!-- One short paragraph on the scope of the change and its observable effect. Not a longer retelling of the line above, and not a list of what each file does. -->

## Changes

- **Before:** <what a reader, a user or the system got before this pull request>
- **After:** <what they get now>

## Artifact

<!-- Proof it works, and the one place paths, commands, output and screenshots belong: a command and what it printed, a file diff, a before-and-after of a page. If no runtime artifact is possible — pure docs, a mechanical refactor — say that in one line rather than inventing one. -->

## Prior / Future work

<!-- "Follows up on: #123 — one line of context" and "Precedes: #124 — one line of context". Drop whichever does not apply; "None." is an answer. -->




---




## Details

<!-- Optional, and deleted unless a reviewer needs a non-obvious decision, a tradeoff, a risk, a limitation, a migration or a rollout note. One short paragraph, or at most three bullets. Link longer analysis rather than pasting it. -->
