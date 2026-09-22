/**
 * @file Fails when a pull request title or body does not follow the house
 * standard. The rules, and the reasoning behind each of them, are in
 * pr_body_rules.js; everything here is reading the text and printing the
 * answer.
 *
 * Two ways in, because a check you can only run by opening a pull request is
 * one you find out about from a red cross:
 *
 *     PR_TITLE="feat(ci): …" PR_BODY="$(cat draft.md)" node scripts/check_pr_body.js
 *     node scripts/check_pr_body.js draft.md
 *
 * `.github/workflows/pr_body.yml` uses the first, out of the event payload.
 * Both arrive in environment variables rather than as arguments because they
 * are text a stranger can write: interpolated into a `run:` line they would be
 * shell, and `$(…)` in a pull request description would execute on the runner.
 * An environment variable is never parsed as anything.
 *
 * The second form takes the body alone and checks the title only if `PR_TITLE`
 * is set, since a draft in a file usually does not have one yet.
 */
const fs = require('node:fs')

const { checkPrBody, checkPrTitle, proseWordCount, MAX_WORDS } = require('./pr_body_rules')

const [, , file] = process.argv
const body = file ? fs.readFileSync(file, 'utf8') : (process.env.PR_BODY ?? '')
const title = process.env.PR_TITLE

const problems = [...(title === undefined ? [] : checkPrTitle(title)), ...checkPrBody(body)]

if (!problems.length) {
  console.log(
    'The body has every section the standard asks for, and ' +
      `${proseWordCount(body)} words of prose against a ceiling of ${MAX_WORDS}.`
  )
  process.exit(0)
}

console.log('This pull request does not follow the house standard:')
console.log('')
for (const problem of problems) console.log(`  * ${problem}`)
console.log('')
console.log('The template is .github/pull_request_template.md, and the rules')
console.log('are CLAUDE.md\'s "Writing a PR description". Edit the description')
console.log('and this check runs again on its own.')
process.exit(1)
