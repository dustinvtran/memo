# Working in this repo

Notes for whoever (or whatever) picks this up next. Conventions the code
already follows, and the traps that cost someone a day the first time.

## Writing a PR description

**Put each paragraph on one long line.** GitHub renders single newlines in
issue and PR bodies as hard `<br>` breaks — unlike `.md` files in the repo,
where they're soft. Prose hard-wrapped at 72 or 80 columns comes out with a
forced break on every line, ragged and unreadable at any window width.

Wrapping is right in **commit messages** (72 columns) and in **`.md` files**
in the repo. It is wrong in anything GitHub renders as a comment: PR bodies,
issue bodies, review comments.

Lists, tables and fenced code blocks are unaffected either way — the rule is
about paragraphs.

Describe the code as it stands, not the path taken to it. A reviewer wants to
know what the branch does and which decisions are worth arguing with, not
what was tried first.

**The shape is `.github/pull_request_template.md`, and it is enforced.** One
sentence from the author, then Summary, Changes as a Before and an After,
Artifact, Prior / Future work — then a horizontal rule, then an optional
Details for whoever is verifying rather than skimming. Above that rule is
natural language: no file paths, no symbol names, no code, because a summary
a reviewer has to read the diff to understand is not a summary. Artifact is
the exception and is where the command, the output and the screenshot belong.

**Writing one needs nobody's help.** The opening line is a single sentence —
what someone skimming a list of merged pull requests would want to read — and
the Summary under it is not a longer retelling of it. The template ships the
literal line `One-sentence summary of PR.` there, in plain text rather than in
a comment, so that leaving it unfilled both fails the check and is visible to
anyone who opens the pull request.

`.github/workflows/pr_body.yml` checks the parts of this that have a
mechanical test — the sections, the ceilings, the wrapping, the unfilled
placeholders, and a Conventional Commit title — and
`node scripts/check_pr_body.js draft.md` asks the same of a file before a pull
request exists. The rest is taste. The numbers and the reasoning are at the
top of `scripts/pr_body_rules.js`.

## Commits

`feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:` prefixes,
optionally scoped (`feat(db_maintenance):`), wrapped at 72 columns. Say why,
not just what — the diff already says what. The same shape is required of a
pull request title, and `.github/workflows/pr_body.yml` checks that half.

**No attribution trailers, and no AI attribution anywhere** — not in a commit
message, not in a pull request description. This replaces the
`Co-Authored-By: Claude …` line the repo used to ask for; commits before
2026-09 still carry it. The one exception is out of our hands: the GitHub API
appends a generated-by line of its own to a body written through it, which
nothing in the repository can suppress.

**Stage each commit's files by explicit path.** `git commit` takes everything
staged, so a blanket `git add -A` or `-u` sweeps whatever else is in the tree
into a message that describes none of it. Concurrent work on this repo is
normal and the tree is rarely clean.

**Review and branch against a freshly fetched `main`, not the checked-out
tree.** Local branches sit around here and the working copy is often weeks
behind, so being stale is the normal state rather than the exception — a review
written against a stale tree reports findings that are already fixed. `git
fetch` first, then read with `git show <remote>/main:<path>` rather than
switching branches. Check `git remote -v` before assuming the remote is called
`origin`: a working copy cloned from another local copy has an `origin` that is
that copy, and it lags whatever is on GitHub.

**A pull request that conflicts with `main` does not trigger CI at all**, and
nothing says so — no queued run, no failed run, no red check.
`gh api repos/.../actions/runs?head_sha=<sha>` answers `total_count: 0` and
`gh pr checks` shows only the Netlify checks, which do run. `pull_request`
workflows build a merge commit, and GitHub cannot build one for a conflicted
PR. So an all-green PR with no `build`/`test` rows is not passing, it is
unmergeable. Check `mergeable` before concluding CI is broken; the other cause
of no run at all is a GitHub Actions outage, and rebasing fixes only the first.

## npm and Google Drive

**`node_modules` in the Drive-synced working copy is unusable.** Drive's
filesystem corrupts npm's many small writes and you get
`ERR_INVALID_PACKAGE_CONFIG` from packages that installed fine a moment ago.
An install takes 10+ minutes and then doesn't work.

Copy the repo to local disk (excluding `node_modules`, `.git`, `backups`
and `.env`), `npm ci` there — about 9 seconds — and invoke scripts by their
local path, pointing them back at the Drive copy's `.env` and `backups` so
the credentials and the snapshots never leave Drive:

```
MEMO_ENV_FILE=/path/on/drive/src/db_maintenance/.env \
  node C:/local/copy/src/db_maintenance/scripts/some_script.js \
  --backup-dir=/path/on/drive/src/db_maintenance/backups
```

The working directory no longer matters — a script resolves its `.env` from
`src/db_maintenance/env.js` and its backups from its own location, so a local
copy would otherwise quietly use the local copy's of each. `MEMO_ENV_FILE`
exists for exactly this; **don't** copy the `.env` to local disk instead.
`--out` / `--dir` do for the backup path what `--backup-dir` does above,
depending on the script.

Same trick for regenerating `package-lock.json`: run
`npm install --package-lock-only` on the local copy and copy the lockfile
back.

**Drive corrupts git's writes too, not just npm's.** A `git reset --hard`
there can report success and leave a tree that is not what was asked for —
files the newest commit adds missing from disk, others holding their
pre-commit content. A later `git add -A` then records that as deletions and
modifications of files the task never touched, and the commit reads fine in
`git show`. Check `git diff --name-status <remote>/main` before committing
from a Drive checkout, and prefer working in a copy on local disk.

**The checkout is CRLF while git stores LF** — `core.autocrlf=true` and no
`.gitattributes`. A scripted edit matching a literal newline therefore finds
nothing, and the failure reads as "the string isn't in the file" rather than
as a line-ending problem. Detect it by counting carriage returns rather than
by eye, and have any script that rewrites a file keep the endings it found
rather than emitting its own.

## Looking at the frontend without netlify dev

`npx netlify dev` needs an interactive `netlify login` and points
`MONGODB_URL` at production Atlas, so it is not the thing to reach for when
you want to see a change draw. Build, then serve `dist/` with the API
answered from fixtures:

```
npx cross-env ELEVENTY_ENV=dev eleventy
node scripts/preview_with_fixtures.js 8099
```

`http://localhost:8099/films/nil` — the url is type first and name last, and
anything that is not a real file is rewritten to `index.html`, because every
url is served the same document and the page is drawn client-side. That is
not the same as a client-side router; see below.

**The fixtures are the whole value, and a wrong one is worse than none.**
Three bugs shipped past a stub that invented shapes the API does not return:
`internalRef` on a list row, which only a *retrieve* sets (#371); no entry
overriding a field of a real work, which is the only case that renders the
override hint (#372); and no `Planned` film, the one status whose completed
date field is hidden and so the one that could carry a date nobody could see.
Each fixture in that file says which case it is for. Add rows rather than
editing them, and check a shape against `src/api/controllers/entries.js`
rather than against memory.

It also has a control route, which is the only way to watch an error reach
the UI: `fetch('/.netlify/functions/__stub?fail=' + encodeURIComponent(msg))`
makes the next non-GET answer 400 with that message. It has to be the *next*
one — the draft autosave fires 2.5s after a form opens and will eat a flag
set before it.

## The frontend is one document per navigation, and one bundle of globals

**There is no client-side router.** `_redirects` serves one `index.html` for
every url and the page is drawn in the browser, so the site reads like an SPA
and is described as one in places. `components/router.js` picks a page
component from `window.location.pathname` **once**, while the bundle is being
evaluated; links are plain `<a href>`, `components/common.js` navigates with
`window.location.href = url`, and saving an entry ends in `location.reload()`.

So every navigation is a fresh document, and any module-level cache — a `Map`
of loaded scripts, `Rows.byRef`, `window.hasUnsavedChange` — lives exactly as
long as one page view. "Navigate away and come back" is not a way to keep
state, and a bug that needs two pages to reproduce cannot be one.

**A hash-only navigation is the exception, and it looks like a broken
feature.** Going from `/films/nil` to `/films/nil#entry-films-10` is a
same-document navigation: no document load, so nothing re-runs.
`components/list/index.js` reads `window.location.hash` in an initializer that
runs once per page load, which is right — every *real* navigation here is a
full load. When testing anchor behaviour in a browser tool, go somewhere else
first, or the feature you just wrote will appear to do nothing.

**The bundle is plain globals concatenated**, in the order `asset_plan.js`
gives, so a library is used two ways: `R.equals(…)` and `const { identity } =
R` at the top of a file. Grepping for `R\.` finds the first and misses the
second, and the second runs while the file is being *read* — a missing global
is a `ReferenceError` at load time, one IIFE throws, the bundle stops, and
**every page is blank**. `npm test` passes, since each test loads one file
into a vm; `node --check` passes; CI passes. Only loading the built site in a
browser finds it, which is what the preview above is for. When removing a
global, grep for the destructured form too.

## ES modules, the functions runtime, and why the API is bundled

**`src/api` is ES modules** — `src/api/package.json` sets `"type": "module"`
for that subtree and nothing else. That is #185's route 3, and
`docs/module_system.md` is the record: what it did not buy, what it cost,
and the import-time rule it leaves behind. Read it before assuming the
bundler is now optional. It is not, and the next paragraph is why.

**The functions runtime cannot `require` an ES module, and `netlify.toml`
bundles the API with esbuild so that it never has to.** Both halves matter:
the constraint is real and permanent, and the reason you can ignore it most
of the time is one line of configuration that nothing else in the repo
asserts.

The failure it prevents is not a bad response from one route. The throw
happens while the module is being read, before a handler runs, so every
route 502s at once: entries, stats, export, auth, the lot. `uuid` 13 did
that to production (#162, fixed by #169) and `jose` 6 would have done it
again (#168).

**The mechanism, which #185 finally read rather than guessed.** A throwaway
function on a deploy preview reported `process.execArgv`, and AWS starts the
runtime with `--no-experimental-require-module` on the command line, by
name, next to `--no-experimental-detect-module`. Identical on `nodejs22.x`,
`nodejs24.x` and `nodejs26.x` — Nodes where `require(esm)` has been stable
and on by default for two releases or more. So this is AWS policy, not version drift: a newer
runtime will not grow out of it, and `NODE_OPTIONS` cannot undo it, because
a command-line flag beats `NODE_OPTIONS`. `process.features.require_module`
is `false` on the deployed runtime for that reason and no other.

**What esbuild does about it.** It inlines dependencies at build time, so
the deployed function has no module boundary left for the runtime to refuse.
The default bundler, `zisi`, copies each function verbatim and ships
`node_modules` beside it, which is exactly how the boundary used to survive
to production. With `node_bundler = "esbuild"` set, an ESM-only package in
the API is simply fine — verified on a preview, where `require` of an
ESM-only package returns cleanly on a runtime still reporting
`features.require_module: false`.

**What still bites.** `external_node_modules` bypasses the bundler by
design, so anything in that list is copied rather than inlined and the
original rule applies to it unchanged. `mongodb` is there because it reaches
its optional native extras — `kerberos`, `snappy`, `aws4`,
`mongodb-client-encryption` — through requires inside `try`/`catch`, for
packages deliberately not installed, and a bundler has to resolve what it
inlines. Before adding anything to that list, ask the loader rather than
reading the package's own metadata — an `exports` map without a `require`
condition does mean ESM-only, but plenty of requireable packages ship no
`exports` map at all, and `mongodb` is one of them:

```
node --no-experimental-require-module -e "require('<pkg>')"
```

That flag turns off the `require(esm)` support the runtime does not have,
which is the whole trick. `scripts/check_function_dependencies.js` runs it
over every external and asserts the bundler is still esbuild, reading both
out of `netlify.toml` rather than keeping a copy that can drift.
`.github/workflows/ci.yml` runs that script.

It replaced a job that loaded every *route* under the same flag. That check
has outlived its question: the source still says `require('jose')` while the
artefact has jose inlined, so an ESM-only dependency would fail it and ship
perfectly well. A check that cries wolf gets deleted, and the real rule
would have gone with it.

**The runtime used to be pinned outside the repo, and #198 removed the pin
rather than mirroring it.** `AWS_LAMBDA_JS_RUNTIME` overrides the runtime and
Netlify reads it only from its UI, CLI or API — never from `netlify.toml`.
Set there, it kept the API on `nodejs18.x` for years — deprecated by AWS in
September 2025, Node 18 itself end-of-life since April 2025 — while
`netlify.toml` pinned `NODE_VERSION = "22"`, CI pinned Node 22, and this file
said the repo builds on Node 22 deliberately. All true, all about the build,
none of it about the runtime that serves requests, and nothing short of
deploying a function that reported `process.version` could have found it.

Netlify has derived the functions runtime from the build's Node since May
2023, and documents that variable as the way to *break* that link when the
two need to differ. They do not need to differ here. So the variable is gone
from the UI, `NODE_VERSION` in `netlify.toml` is the whole configuration —
one number, in the repo, for the build and the API alike — and
`scripts/check_function_dependencies.js` fails the deploy if a Netlify build
is ever handed that variable again. An override is now a failure rather than
a value to keep in sync, which is a much easier thing to get right than two
places that must agree.

**Why 24 and not something newer**, since #198 measured it and the number
looks arbitrary otherwise. AWS ships a managed Lambda runtime only for Node
majors on the LTS track, so there is no `nodejs25.x` and never will be.
`nodejs26.x` does exist, as a **public preview** — no SLA, no support,
breaking changes auto-applied, GA targeted for November 2026 — and Netlify
will not derive a runtime from it: a preview deploy built on Node 26,
`NODE_VERSION = "26"` asked for and honoured at `v26.1.0`, put its functions
on `nodejs24.x` anyway. Netlify substitutes rather than failing, and it
substitutes *after* the build, so nothing on the build side can see it
happen. Node 26 is therefore the one value this file cannot tell the truth
about, which makes it the #185 bug again with a different number. 24 is the
newest that stays true, and is generally available on Amazon Linux 2023 with
AWS support to April 2028. When 26 goes GA, this is a one-line change plus
the allowlist in the script.

The script keeps that allowlist — the majors Netlify will actually derive,
not the ones AWS ships — so a version that would be quietly substituted fails
before a deploy rather than being discovered after one. It also checks
`netlify.toml` against both CI pins, which `ci.yml` had only ever *said* it
matched, and on Netlify checks that the build really got the Node it asked
for, since that is what the functions inherit.

**Migrating the source to ESM did not change any of the above**, which is
the one thing to hold on to. esbuild flattens an ESM source to a CommonJS
bundle, so the artefact is CommonJS either way and every line above still
describes production. What the migration did buy was the death of the
`Module._load` patching in the controller tests — and that was worth having
because those patches existed to work around four modules that built
clients, and threw on missing credentials, while they were being imported.

**The rule that leaves: importing anything under `src/api` must not read a
credential, open a connection or build a client.** Do it on first use
instead, behind a seam the suite can replace — `useClient`, `useAdapters`,
`useLoader` are the three. `check_function_dependencies.js` loads
every route with the environment passed through untouched, so breaking this
fails CI rather than a deploy.

**`src/db_maintenance` is still CommonJS and requires three modules out of
`src/api`**, so it depends on `require(esm)` — unflagged since Node 22.12,
and the repo pins 24. The AWS flag has nothing to do with it: only
`src/api/routes` is deployed. It would break if any of those modules grew a
top-level `await`, and `index_plan.test.js` and `game_playtime_plan.test.js`
are what catch that, in CI's dependency-free job.

## Credentials

`src/db_maintenance/.env` holds `MONGODB_URL`, `TWITCH_CLIENT_ID`,
`TWITCH_CLIENT_SECRET`, `TMDB_API_KEY`, `GOOGLE_API_KEY`. Never print the
values, and never copy the file anywhere — if something can't see it from
where it is, point it at the file with `MEMO_ENV_FILE` rather than moving
the file to it.

It is gitignored, so it exists **only in the main checkout**. A worktree or a
fresh clone does not have one, and pointing `MEMO_ENV_FILE` at a path that
lacks it fails as `TypeError: Cannot read properties of undefined (reading
'startsWith')` from `mongodb-connection-string-url` — an unset `MONGODB_URL`,
not a bad one. Point it at the main checkout's copy.

Loading it is `src/db_maintenance/env.js`'s job, and every script's first
line is `require("../env")`. Don't call `dotenv` directly in a new script:
a bare `config()` resolves against the working directory, which is how the
scripts came to only work when run from one particular folder.

## Writing to the database

`src/db_maintenance/scripts/` operates on production data with real users'
entries. In order:

1. **Snapshot first, always, no exceptions.** Take a fresh snapshot with
   `scripts/backup_database.js` immediately before every `--apply`, and
   verify it with `scripts/verify_backup.js --live` — manifest counts, file
   counts, the `sha256` of every file and live `countDocuments()` should
   agree across every collection, and it exits non-zero when the first three
   don't. Don't hand-roll that check. There is no write small enough,
   safe-looking enough or reversible-looking enough to skip this: a snapshot
   costs seconds and is the only thing standing between a mistake and a
   restore. It applies to writes that touch no documents at all — an index
   build, a collection setting — because the reason to have the snapshot is
   that you were wrong about what the run would do.
   `scripts/restore_backup.js --from=<snapshot> --only=<collection>` matches
   on `_id` only.
2. **Dry run, and read the output.** Every script here is a dry run unless
   given `--apply`. Keep it that way in new ones.
3. **`--apply` against production is authorised**, given steps 1, 2 and 4.
   Say which snapshot you took and what the dry run said. Anything a restore
   from that snapshot would not undo — dropping a collection or an index,
   changing credentials, writing to a database other than `memo` — is still
   a human's call, so ask first.
4. **Verify afterwards**: no entry pointing at a work that doesn't exist, and
   entry counts unchanged.

Write only to the **work** collections. User overrides live on entry
documents (`entry.overrides`), so a script that never touches `*Entries`
cannot clobber one.

Two exceptions delete review documents, and neither writes to an entry.
`scripts/prune_orphan_reviews.js` deletes reviews whose entry is gone — notes
no code path can reach, since a review is only ever looked up by `entryRef`.
`scripts/prune_unreachable_documents.js --only=reviews` (#339) deletes reviews
holding the empty string — notes a code path reaches and finds empty, which is
the narrower claim and so the harder one to make. Its argument is *not* that
an empty string is meaningless: it is deliberately a real value, and #213 is
the bug that comes of confusing "absent" with "empty". It is that
`updateEntry_` writes the document again on the next save whether or not it is
there, and that `getReview`, the export and `changedFields` all treat the two
states alike — verified, and pinned by tests in
`src/api/controllers/entries.test.js`. **That half has not been applied**; its
works half, which writes only to the work collections, needs no exception.

Both read `*Entries` and neither writes to them. Two other scripts do write
outside the work collections. `clear_noop_overrides.js` reaches an override,
and argues its own case in its file header and in
`src/db_maintenance/README.md`, which carries the whole list. There were three
until #351: `strip_dead_entry_fields.js` and `retype_entry_revisions.js` were
migrations against bugs since fixed in code (#176 and #220), and both are in
git history rather than in the folder.

`link_entry.js` (#343) is the second, and writes both an entry's `workRef` and
the name it is filed under. **What makes it allowed is that it is not a
population.** Every operation names one entry by its id, and every `entryTitle`
it writes was typed by hand, for that row, by the person whose row it is — the
script selects nothing and infers nothing, it takes its work from a file a
human filled in. It is also why the two halves of that repair are two scripts:
`set_work_ref.js` renames a *work* to the API's own title, which can leave a
name like `Portal 2: Coop` written down nowhere, and it says so rather than
writing an override to fix it. Inventing that text is the line.

Adding another is a human's call, and "it only touches one field" is not the
test: the rule is what keeps a maintenance script away from text people can
still read, and a script that chooses its own targets fails it however
carefully the field was chosen.

## Tests

`npm test` is `node --test`, and CI also parses every tracked `.js` file.

The suite runs with **no install, no database and no API keys**, and that is
worth protecting: put the logic that decides what gets written in a pure,
dependency-free module and the I/O in the script that calls it. In
`src/db_maintenance` that split is the folder layout — the modules and their
tests sit at the top, the scripts in `scripts/`. See
`work_metadata_merge.js`, `game_playtime_plan.js`, `work_dedupe_plan.js`,
`backup_plan.js` — and their tests.

Tests that do need the dependencies skip themselves when they aren't there.

**An array returned from a frontend test's `vm` context fails
`deepStrictEqual`.** `columns.test.js`, `tables.test.js` and
`table_model.test.js` run a bundle file inside `vm.createContext`, so an array
the module builds carries that context's `Array.prototype`. `deepStrictEqual`
compares prototypes and refuses it against a host literal with "Values have
same structure but are not reference-equal" — printed about two empty arrays,
which reads as a bug in the assertion library. Copy the value over first:
`assert.deepEqual([...returned], [...])`. Only object and array returns are
affected; strings and numbers cross realms fine.

## Data traps

- **`apiRefs` are flat strings** (`igdb__1234`), with a few legacy
  `{ name, ref }` objects. Some are placeholders — 27 games carry
  `hltb__N/A`, 14 films carry `undefined__undefined`. Use `parseApiRef` /
  `findApiRef` from `work_collections.js`, which reject those, rather than
  splitting on `__` yourself.
- **A shared apiRef is not proof two documents are the same work.** 44 of 78
  apiRef groups here are distinct works: "Fargo - Season 1" and "Season 2"
  under one show id, five Haruhi Suzumiya volumes under one ISBN. Merging on
  an apiRef alone destroys data.
- **A work is the API's copy and a person's name for it lives on their
  entry.** `docs/works_and_entries.md` is the record: why the split exists,
  what keeps user text out of a work today, and the failure when a row is
  stored the other way round — the title guard refuses every refresh and the
  work is frozen silently, which is where #381's 93 came from.
- **A stored `duration` of `0` is not a duration.** It renders as `-` exactly
  as a missing one does, and since #318 `isEmptyValue` says so, so the audit
  reports it missing, `hasGaps` picks the work up and a `missingOnly` merge
  overwrites it. Before that it was a value nothing could replace: present
  enough to satisfy all three, and a number, so `isCorruptNumber` would not
  let `clear_unusable_work_fields.js` take it either. 49 works sat that way.
  The rule now is that **`0` is empty for every field**, which is safe only
  because every numeric field is a `duration`, a `releaseYear` or an
  `episodes` count and none of them has a meaningful zero. A field where zero
  is a real answer would need this decided again, in `isEmptyValue`, not
  worked around at the call site.
- **The audit's `missingFields` count is not a list of work to do.** It
  reports a gap in our copy and cannot tell one the API would fill from one
  nobody has the data for. Of 497 across films, tv and games, a
  `--missing-only` pass wrote to **eleven**: 377 came back "already current"
  because TMDB holds no cast for that film and IGDB no publisher for that
  game, and the rest were works the title guard had frozen. An issue was
  filed against the 497 as though they were fillable, and running it is what
  showed otherwise — so measure with a dry run before treating the number as
  a backlog. #381.
- **A book's ISBN names an edition, not the book.** Google Books answers
  about the printing, so a *refresh* of `releaseYear` moves a public-domain
  work forward to whatever reprint the ISBN belongs to — of seven year changes
  a 60-book dry run proposed, six replaced a stored year and all six were
  that, `Robinson Crusoe` 1719 to 2019 among them. Page counts go the same
  way. Both are on books'
  `fillOnlyFields` in `work_collections.js` for that reason: filled when
  absent, never replaced. The cover, the link and the publisher are the
  edition's too and are refreshed anyway, because a link that resolves today
  beats one that resolved five years ago. #333.
- **`durationSource` records where a playtime came from.** `"igdb"` means
  IGDB's `/game_time_to_beats`; absent means it predates the field and came
  from HowLongToBeat. Never write one without writing the duration it
  describes. See `docs/API_choices.md`.
- **Correcting a work's identity ref must clear its `duration` and
  `durationSource` too.** A stored playtime is only replaced by the source
  that wrote it — `work_metadata_merge.js` refuses to overwrite an IGDB number
  with a HowLongToBeat one or the reverse, because the two are medians over
  very different sample sizes and swapping them moves numbers people have
  already read. That rule assumes the stored duration is about the same work.
  After a repoint it is not: it describes whatever the old ref named. Two
  games were repointed in 2026-09 — `Super Mario Odyssey` off a fan game's id,
  `Hitman 3` off the Cloud Version's — and both kept playtimes from the wrong
  game through the next refresh, which reported `kept the stored duration 780
  (source unrecorded); igdb offered 1115` and said nothing else about it.
  Clearing both fields lets the next run fill them and record where from.

  **Widening a work is the same event without a repoint.** A work that had no
  identity ref, retitled from a part to the whole as one is given to it —
  `Resident Evil 4: Assignment Ada` becoming `Resident Evil 4`, `Spyro
  Reignited Trilogy: Spyro 2` becoming the trilogy — keeps a playtime measured
  for the part. Both of those did in 2026-09: one hour for Resident Evil 4, and
  nine for a twenty-five hour trilogy. The ref never changed, so nothing in the
  repoint rule fires; the work it describes changed anyway. The test is whether
  the stored title *contained* the new one, which is the same test
  `set_work_ref.js` warns on.
- **A books `apiRef` is prefixed and a check's is not.** Documents carry
  `ISBN__9782709637411` and `google__9782709637411`; an identity check's
  `apiRef` for books is the bare number. Films, tv and games use the prefixed
  form either way, so the mismatch is books-only and silent — an analysis that
  groups works by that string finds zero partners for every book and reports
  all their values as unshared. #313's split came out 162/114 that way when the
  real answer was 220/56, and the whole gap was books. Resolve a group by
  looking each member's id up in the works array, the way `planSharedRefRepair`
  does, never by matching an apiRef string.
- **Refusals cluster at the head of a backfill queue.** `selectForRefresh`
  sorts longest-unchecked first, and a work that never merged successfully is a
  work with no `metadataUpdatedDate` — so the two populations are nearly the
  same set and the refusal rate is wildly front-loaded. Measured on books: 144
  of the first 150 refused, the next 178 produced three. A 96% refusal rate in
  the first progress line is expected, not a broken guard; wait for the queue
  to pass the never-checked block before judging.
- **Google Books does not fail cleanly at its cap.** It allows roughly 1,000
  calls a day and starts answering 429 partway through a long crawl. A refused
  page comes back *empty*, which is indistinguishable from a page that found
  nothing, so a bulk search must count failures per item and report "not
  searched" separately or it invents findings out of unanswered questions. The
  same shape bit `q=isbn:` lookups, which answer 200 with no `items` for both a
  missing book and a transient miss — #375 made that raise `EMPTY_LOOKUP` so
  `retrying` can see it.
- **Google Books search carries the subtitle and retrieve does not.**
  `google_search.js`'s `titleOf` joins title and subtitle as `"Title:
  Subtitle"`; `google.js`'s retrieve maps `englishTranslatedTitle:
  volumeInfo.title` alone. So a book stored under its full subtitled name
  matches a search candidate and then fails `titlesAgree` when the same ISBN is
  retrieved — `The Idea Factory: Bell Labs and the Great Age of American
  Innovation` retrieves as `The Idea Factory`. Repointing such a book at a
  "better" ISBN does not help; the write refuses either way.
- **Entries with no `workRef` are deliberate, and are not the dangling-ref
  count.** The audit prints them on the line above, and only the second is an
  integrity violation. The no-`workRef` ones are what `readForm` writes when
  somebody types a title instead of picking a search result — unreleased
  sequels, mods, tabletop games, short stories no API has — and their metadata
  lives in `entry.overrides`, so they render correctly. Do not repoint or
  delete them. Read `entriesWithDanglingWorkRef` in the audit's `--json` before
  treating a no-`workRef` count as breakage.
- **Production is effectively a single-user site.** Six accounts, two with any
  entries, and one of those two holds all but a few dozen. Nothing else in the
  repo records it, and it is the deciding fact for any feature whose value
  scales with other users — discussion, profile comments, likes, a global feed,
  "trending this week" all multiply by a number that is currently 1. Features
  useful at N=1 are a different question and stand on their own merits.
- **IGDB replaced `external_games.category`** with
  `external_games.external_game_source` (`1` = Steam). Querying the old field
  returns zero rows silently instead of erroring.
- **TMDB's `/tv/{id}/credits` has no director in it.** It is the production
  crew: Twin Peaks lists 45 people and not one is filed as `Director` or
  `Series Director`. A show's Director column comes from `created_by` on the
  details response, with the crew filter kept only as a fallback for the shows
  that do carry one — see `showDirectors` in `tmdb_mapping.js` and #328, which
  is what 456 of 510 shows missing a director for ever looked like. Films are
  different and fine: `/movie/{id}/credits` really does carry `Director`.
