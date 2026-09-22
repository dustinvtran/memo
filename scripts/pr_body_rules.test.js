const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  REQUIRED_HEADINGS,
  DETAILS_HEADING,
  TLDR_PLACEHOLDER,
  MAX_WORDS,
  MAX_SECTION_WORDS,
  SECTION_WORDS,
  MAX_DETAILS_BULLETS,
  checkPrBody,
  checkPrTitle,
  proseWordCount,
} = require('./pr_body_rules')

const TEMPLATE = path.join(__dirname, '..', '.github', 'pull_request_template.md')

const TLDR = 'Pull request bodies now have to follow a template, and a check that says so.'

/** A body that follows the standard, as one string per part so that a test can
 * replace exactly the part it is about. */
const SECTIONS = {
  Summary:
    'Adds a template for pull request descriptions and a check that fails a body which does not follow it.',
  Changes: [
    '- **Before:** a description could be any shape and any length, and nothing ever said otherwise.',
    '- **After:** a reviewer gets the same four sections every time, and an over-long one is refused.',
  ].join('\n'),
  Artifact: 'Run against a deliberately bad body:\n\n```\nnode scripts/check_pr_body.js bad.md\n```',
  'Prior / Future work': 'Follows up on: #368 — the issue asking for this.',
}

/** @type {(parts?: {tldr?: string, sections?: Record<string, string>, details?: string}) => string} */
const bodyOf = ({ tldr = TLDR, sections = SECTIONS, details } = {}) => {
  const head = [
    tldr,
    '',
    ...Object.entries(sections).map(([heading, text]) => `## ${heading}\n\n${text}\n`),
  ].join('\n')
  return details === undefined ? head : `${head}\n---\n\n## ${DETAILS_HEADING}\n\n${details}\n`
}

/** @type {(count: number) => string} One long line, so only the count is wrong. */
const words = (count) => Array.from({ length: count }, () => 'word').join(' ')

/** @type {(heading: string, text: string) => string} */
const withSection = (heading, text) => bodyOf({ sections: { ...SECTIONS, [heading]: text } })

test('a body that follows the standard passes', () => {
  assert.deepEqual(checkPrBody(bodyOf()), [])
})

test('the template\'s opening placeholder fails rather than shipping', () => {
  const problems = checkPrBody(bodyOf({ tldr: TLDR_PLACEHOLDER }))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /still the template's/)
  assert.match(problems[0], /it renders/)
})

test('a body that opens straight into a heading has no summary sentence', () => {
  const problems = checkPrBody(bodyOf({ tldr: '' }))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /one-sentence summary/)
})

test('the opening is one sentence, not a paragraph', () => {
  const problems = checkPrBody(bodyOf({ tldr: words(SECTION_WORDS[''] + 1) }))
  assert.equal(problems.length, 1)
  assert.match(problems[0], new RegExp(`opening is \\d+ words against a ceiling of ${SECTION_WORDS['']}`))
})

test('an opening at its ceiling passes', () => {
  assert.deepEqual(checkPrBody(bodyOf({ tldr: words(SECTION_WORDS['']) })), [])
})

test('a missing section is named, and so is the template', () => {
  const { Artifact, ...rest } = SECTIONS
  const problems = checkPrBody(bodyOf({ sections: rest }))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no "## Artifact" section/)
  assert.match(problems[0], /pull_request_template\.md/)
})

test('a section left empty fails, which is the template submitted untouched', () => {
  const problems = checkPrBody(withSection('Artifact', ''))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /"## Artifact" is empty/)
})

test('the sections have to be in the standard\'s order', () => {
  const swapped = {
    Summary: SECTIONS.Summary,
    Artifact: SECTIONS.Artifact,
    Changes: SECTIONS.Changes,
    'Prior / Future work': SECTIONS['Prior / Future work'],
  }
  const problems = checkPrBody(bodyOf({ sections: swapped }))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /sections run/)
})

test('Changes wants a Before bullet and an After bullet', () => {
  const problems = checkPrBody(
    withSection('Changes', '- **After:** the check refuses a body without both halves.')
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no "\*\*Before:\*\*" bullet/)
})

test('a Before bullet with nothing after its label is not an answer', () => {
  const problems = checkPrBody(
    withSection('Changes', '- **Before:**\n- **After:** the two halves each say something.')
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /says nothing after its label/)
})

test('a path or a symbol above the rule is refused', () => {
  for (const summary of [
    'The rules live in `scripts/pr_body_rules.js`, which the workflow calls.',
    'The change is in ci.yml and nowhere else.',
    'It calls `checkPrBody()` once per run.',
  ]) {
    const problems = checkPrBody(withSection('Summary', summary))
    assert.equal(problems.length, 1, summary)
    assert.match(problems[0], /natural language/)
  }
})

test('a fenced code block above the rule is refused too', () => {
  const problems = checkPrBody(withSection('Summary', 'It runs:\n\n```\nnpm test\n```'))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /fenced code block/)
})

test('Artifact is the exception, and carries paths, commands and output', () => {
  const artifact = [
    'The check against a body missing a section:',
    '',
    '```',
    '$ node scripts/check_pr_body.js bad.md',
    '  * The body has no "## Artifact" section.',
    '```',
  ].join('\n')
  assert.deepEqual(checkPrBody(withSection('Artifact', artifact)), [])
})

test('a link above the rule is not a file path', () => {
  const summary =
    'The reasoning is written up at https://example.com/notes/pr-standards.md and not repeated here.'
  assert.deepEqual(checkPrBody(withSection('Summary', summary)), [])
})

test('an unfilled angle-bracket placeholder fails', () => {
  const problems = checkPrBody(
    withSection(
      'Changes',
      '- **Before:** <what a reader got before this pull request>\n- **After:** the same four sections every time.'
    )
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /still unfilled/)
})

test('a hard-wrapped paragraph fails, and the message says why', () => {
  const wrapped = [
    'GitHub renders a single newline in a pull request body as a hard line',
    'break, so a paragraph wrapped at seventy-two columns comes out ragged at',
    'every window width the reviewer might be using.',
  ].join('\n')
  const problems = checkPrBody(withSection('Summary', wrapped))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /2 line\(s\) look hard-wrapped/)
  assert.match(problems[0], /one long line/)
})

test('a wrapped line inside a fenced code block is not a wrapped paragraph', () => {
  const fenced = [
    'The command that failed, and what it said:',
    '',
    '```',
    'This is a long line of program output that runs well past sixty columns,',
    'and the line under it is more of the same output rather than a paragraph.',
    '```',
  ].join('\n')
  assert.deepEqual(checkPrBody(withSection('Artifact', fenced)), [])
})

test('two short lines are not a wrapped paragraph', () => {
  const both = 'Follows up on: #368 — the issue.\nPrecedes: #370 — the follow-up.'
  assert.deepEqual(checkPrBody(withSection('Prior / Future work', both)), [])
})

test('a rule under a long line is a setext heading, not a wrap', () => {
  const underlined =
    'A line of text that is comfortably longer than sixty columns\n---\nAnd the paragraph under it.'
  assert.deepEqual(checkPrBody(withSection('Summary', underlined)), [])
})

test('the Summary has a tighter ceiling than the default', () => {
  const problems = checkPrBody(withSection('Summary', words(SECTION_WORDS.Summary + 1)))
  assert.equal(problems.length, 1)
  assert.match(problems[0], new RegExp(`"## Summary" is \\d+ words against a ceiling of ${SECTION_WORDS.Summary}`))
})

test('a section the standard does not size gets the default ceiling', () => {
  const problems = checkPrBody(withSection('Artifact', words(MAX_SECTION_WORDS + 1)))
  assert.ok(problems.some((problem) => new RegExp(`ceiling of ${MAX_SECTION_WORDS}`).test(problem)))
})

test('a body over the ceiling fails on the total', () => {
  const body = bodyOf({
    sections: {
      ...SECTIONS,
      Summary: words(SECTION_WORDS.Summary),
      Artifact: words(MAX_SECTION_WORDS),
      Changes: `${SECTIONS.Changes}\n\n${words(MAX_SECTION_WORDS)}`,
    },
  })
  const total = checkPrBody(body).find((problem) => /words of prose/.test(problem))
  assert.ok(total, 'expected a total-length problem')
  assert.match(total, new RegExp(`ceiling of ${MAX_WORDS}`))
})

test('code blocks and tables are not prose, and do not count', () => {
  const quoted = ['```', words(MAX_WORDS), '```', '', '| a | b |', '| --- | --- |'].join('\n')
  assert.deepEqual(checkPrBody(withSection('Artifact', quoted)), [])
})

test('a section that is only a code block has been answered, not left empty', () => {
  assert.deepEqual(checkPrBody(withSection('Artifact', '```\n$ npm test\n# pass 1198\n```')), [])
})

test('Details is optional', () => {
  assert.deepEqual(checkPrBody(bodyOf()), [])
  assert.deepEqual(
    checkPrBody(bodyOf({ details: 'The ceiling is the median of what has been merged here, deliberately.' })),
    []
  )
})

test('Details below no horizontal rule loses the line it is supposed to be below', () => {
  const body = `${bodyOf()}\n## ${DETAILS_HEADING}\n\nA note a reviewer needs.\n`
  const problems = checkPrBody(body)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no horizontal rule above "## Details"/)
})

test('Details is one paragraph or three bullets, not a fourth', () => {
  const four = Array.from({ length: MAX_DETAILS_BULLETS + 1 }, (_, i) => `- Point ${i}.`).join('\n')
  const problems = checkPrBody(bodyOf({ details: four }))
  assert.equal(problems.length, 1)
  assert.match(problems[0], new RegExp(`${MAX_DETAILS_BULLETS + 1} bullets`))
})

test('Details may carry the paths the sections above may not', () => {
  const details = 'The ordering comes from `work_collections.js` and is deliberate.'
  assert.deepEqual(checkPrBody(bodyOf({ details })), [])
})

test('the template\'s own instructions do not count against the ceiling', () => {
  const body = `<!--\n${words(MAX_WORDS)}\n-->\n\n${bodyOf()}`
  assert.deepEqual(checkPrBody(body), [])
  assert.equal(proseWordCount(body), proseWordCount(bodyOf()))
})

test('an empty body fails rather than throwing', () => {
  for (const body of ['', null, undefined]) {
    assert.equal(checkPrBody(body).length, REQUIRED_HEADINGS.length + 1)
  }
})

test('a body with CRLF line endings is read the same way', () => {
  assert.deepEqual(checkPrBody(bodyOf().replace(/\n/g, '\r\n')), [])
})

test('a title has to be a Conventional Commit', () => {
  for (const title of [
    'feat(ci): fail a pull request whose body ignores the template',
    'fix: answer the CORS preflight',
    'chore(deps-dev): bump netlify-cli',
  ]) {
    assert.deepEqual(checkPrTitle(title), [], title)
  }
  for (const title of ['Fail a pull request whose body ignores the template', 'feat: ', 'feat(ci) no colon', '']) {
    assert.equal(checkPrTitle(title).length, 1, title)
  }
})

test('the title check is skipped when no title is offered', () => {
  assert.deepEqual(checkPrTitle('feat(ci): a title'), [])
})

test('the template on disk has the headings the check asks for, in order', () => {
  const headings = [...fs.readFileSync(TEMPLATE, 'utf8').matchAll(/^## (.+)$/gm)].map(([, h]) =>
    h.trim()
  )
  assert.deepEqual(headings, [...REQUIRED_HEADINGS, DETAILS_HEADING])
})

test('the template ships the placeholder the check looks for, spelled the same', () => {
  assert.ok(
    fs
      .readFileSync(TEMPLATE, 'utf8')
      .split(/\r?\n/)
      .some((line) => line.trim() === TLDR_PLACEHOLDER),
    `the template has no line reading exactly "${TLDR_PLACEHOLDER}"`
  )
})

test('the template submitted untouched fails, starting with the placeholder', () => {
  const problems = checkPrBody(fs.readFileSync(TEMPLATE, 'utf8'))
  assert.match(problems[0], /still the template's/)
  /* Every section but Changes, whose placeholder bullets are content; that one
     is caught as an unfilled placeholder instead. */
  for (const heading of REQUIRED_HEADINGS.filter((h) => h !== 'Changes')) {
    assert.ok(
      problems.some((problem) => problem.startsWith(`"## ${heading}" is empty`)),
      `expected "## ${heading}" to be reported empty`
    )
  }
  assert.ok(problems.some((problem) => /still unfilled/.test(problem)))
})

test('the rule before Details is not content of the section above it', () => {
  const body = bodyOf({
    sections: { ...SECTIONS, 'Prior / Future work': 'None.' },
    details: 'A note a reviewer needs.',
  })
  assert.deepEqual(checkPrBody(body), [])
})
