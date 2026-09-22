/**
 * @file The rules a pull request title and body have to satisfy, as pure
 * functions of the text. Dependency-free, so `npm test` exercises them with no
 * install — see pr_body_rules.test.js. The I/O half lives in
 * scripts/check_pr_body.js.
 *
 * ## Why a check rather than a note in CLAUDE.md
 *
 * CLAUDE.md has described how to write a description here for as long as there
 * have been descriptions, and #369 is the observation that describing it does
 * not make it happen: the bodies kept growing, because nothing ever went red
 * over one. What is below is the subset of the house standard with a
 * mechanical test. The rest of it — whether the Summary is the right summary,
 * whether the Artifact really proves anything — is taste, stays in prose, and
 * is deliberately not guessed at here.
 *
 * ## The shape, and what each part of it is for
 *
 * A body opens with one sentence, then four sections that orient a reviewer
 * without making them read code — Summary, Changes, Artifact, Prior / Future
 * work — then a horizontal rule, then an optional Details for whoever is
 * verifying rather than skimming. The rule is load bearing: above it is for
 * skimmers, below it is for verifiers.
 *
 * **The opening sentence is one sentence.** It is whatever a reader skimming a
 * list of merged pull requests needs, and the Summary underneath is not a
 * longer retelling of it. Nothing here needs a human to supply it, so the
 * template ships a placeholder rather than a handoff — and a body still
 * carrying that placeholder fails, because an unfilled line that renders is
 * worse than a blank one that does not.
 *
 * **The four sections above the rule are natural language.** A file path or a
 * symbol name in them is a reviewer being asked to read code to understand the
 * summary of the code, and a description that only makes sense to someone who
 * already knows the repository is not a description. Artifact is the exception
 * and is exempt from every part of it, because it is evidence: a command and
 * its output, a diff, a screenshot.
 *
 * **There is a ceiling on words.** This is #369's actual complaint, and the
 * only rule here aimed at verbosity rather than form. The numbers were
 * measured; see MAX_WORDS.
 *
 * **A paragraph may not be hard-wrapped.** GitHub renders a single newline in
 * a comment as a `<br>`, so prose wrapped at 72 or 80 columns comes out with a
 * forced break on every line. This is the rule broken most often, because
 * wrapping is *right* in commit messages and in `.md` files in this repo and
 * the habit carries over.
 *
 * Fenced code, tables, lists and block quotes are exempt from the ceiling and
 * the wrapping rule everywhere. A newline means what it looks like there, and
 * a quoted diff would otherwise blow the ceiling on its own and take the
 * useful part of the check with it.
 */

/**
 * The template's headings, in order. Kept here rather than read out of
 * .github/pull_request_template.md because a body is checked from a workflow
 * holding the repository at whatever revision the pull request proposes, so
 * reading the template would let a branch relax the check by editing the
 * template in the same commit. A test asserts the two agree.
 */
const REQUIRED_HEADINGS = ['Summary', 'Changes', 'Artifact', 'Prior / Future work']

/** Allowed, but only after the horizontal rule, and only when it earns its place. */
const DETAILS_HEADING = 'Details'

/**
 * The sections a reviewer reads before deciding whether to read the diff. `''`
 * is the unheaded opening, which is the author's sentence. Artifact is not
 * here: it is the one section that is supposed to contain code.
 */
const HIGH_LEVEL = ['', 'Summary', 'Changes', 'Prior / Future work']

/**
 * The line the template ships where the opening sentence goes, matched exactly
 * so that the check and the template cannot drift apart without a test
 * noticing. It is plain text rather than an HTML comment on purpose: a comment
 * left in place is invisible and would have to be caught by its absence, and
 * this way the failure is legible in the rendered body as well as here.
 */
const TLDR_PLACEHOLDER = 'One-sentence summary of PR.'

/**
 * Measured, not guessed. Of the last 36 merged pull requests written here by a
 * person, counted by countWords below — so excluding code blocks and tables,
 * which is all description: the median body is 499 words, a quarter are over
 * 906, a tenth over 1168, and the longest is 2026.
 *
 * 500 is that median, which means half of what has already been merged here
 * would have had to be cut. That is the choice rather than an accident of
 * rounding: the distribution being measured is the one #369 is a complaint
 * about, so a ceiling set at its own p90 would pass 32 of 36 bodies and
 * enforce nothing.
 */
const MAX_WORDS = 500

/**
 * And a ceiling per section, so the total cannot all be spent in one place.
 * Measured the same way over the 87 `##` sections in those 36 bodies: the
 * median is 141 words, three quarters are under 208 and the longest is 482, so
 * 250 leaves 72 of the 87 untouched.
 *
 * The three overrides are the sections the standard itself sizes — a Summary
 * is "one short paragraph", Prior / Future work is two one-line entries, and
 * Details is "one short paragraph or at most three bullets". Each number is a
 * reading of those words and nothing more; the default is what applies where
 * the standard says only "high-level".
 */
const MAX_SECTION_WORDS = 250
const SECTION_WORDS = {
  /* The unheaded opening. "One sentence" has no honest mechanical test —
     splitting on full stops argues with every abbreviation — so this is the
     cheap proxy: long enough for a sentence with room to breathe, short
     enough that a paragraph cannot hide here. */
  '': 45,
  Summary: 150,
  'Prior / Future work': 80,
  [DETAILS_HEADING]: 150,
}

/** "At most three bullets", said of Details and checkable only there. */
const MAX_DETAILS_BULLETS = 3

/**
 * A line this long or longer, with prose directly under it, is a wrap rather
 * than a deliberately short line. Wrapping happens at 72 or 80 columns, so 60
 * is comfortably inside the band, and a pair of genuinely short lines —
 * `Follows up on: #368` over `Precedes: #370`, which renders exactly as
 * intended — is nowhere near it.
 *
 * Checked against the same 36 bodies: none of them trips it. A rule that fires
 * on nothing already written is the one worth having, since every hit is then
 * something new rather than a habit the repository has and tolerates.
 */
const WRAPPED_LINE_COLUMNS = 60

/**
 * Conventional Commits, with the types this repository uses. The scope is left
 * open rather than given an allowlist: scopes here name the module touched and
 * there are sixteen of them in the history — `db_maintenance`, `api`, `list`,
 * `set_work_ref` — so a list would be a second place to keep in step with the
 * code rather than a check.
 */
const TITLE_SHAPE = /^(?:feat|fix|refactor|test|docs|chore)(?:\([a-z0-9_.-]+\))?: \S/

/** Markdown fence, opening or closing, at up to three spaces of indent. */
const FENCE = /^ {0,3}(?:```|~~~)/

/** Anything that is not a prose paragraph line: headings, list items and their
 * indented continuations, table rows, block quotes, indented code, raw HTML,
 * and a rule or setext underline. */
const NOT_PROSE = [
  /^ {0,3}#{1,6}\s/,
  /^\s*(?:[-*+]|\d+[.)])\s/,
  /^\s*\|/,
  /^\s*>/,
  /^(?: {4,}|\t)/,
  /^\s*<\/?[a-zA-Z!]/,
  /* `---` directly under a line of text makes that line a setext heading
     rather than a wrapped paragraph, which is the one way a genuine hit could
     be wrong. */
  /^ {0,3}(?:-{3,}|={3,}|\*{3,}|_{3,})\s*$/,
]

/** File-ish endings, for spotting a path where prose was asked for. */
const EXTENSIONS = 'js|mjs|cjs|json|md|ya?ml|toml|njk|css|html|sh|txt'

/** An unfilled `<like this>` placeholder from the template. Fifteen characters
 * so that a stray `<details>` or `<br>` is not mistaken for one. */
const PLACEHOLDER = /<[^<>]{15,}>/

/** @type {(line: string) => boolean} */
const isProse = (line) => line.trim() !== '' && !NOT_PROSE.some((re) => re.test(line))

/**
 * HTML comments carry the template's instructions, so a body that keeps them
 * is following the template rather than ignoring it and they must not count
 * against any ceiling or trip any rule. They are blanked rather than deleted
 * so every line keeps its number, which is what the messages below quote.
 * @type {(body: string) => string}
 */
const withoutComments = (body) =>
  body.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ''))

/**
 * Which lines are inside a fenced code block. Computed once for the whole
 * body: a fence opened under one heading and closed under the next is still
 * one block, and a section-by-section pass would read the tail of it as prose.
 * @type {(lines: string[]) => boolean[]}
 */
const fencedLines = (lines) => {
  let open = false
  return lines.map((line) => {
    if (FENCE.test(line)) {
      open = !open
      return true
    }
    return open
  })
}

/**
 * The body split at its `##` headings. The first section has no heading and is
 * the author's opening sentence.
 * @type {(lines: string[], fenced: boolean[]) => {heading: string, lines: string[], fenced: boolean[], from: number}[]}
 */
const sectionsOf = (lines, fenced) => {
  const sections = [{ heading: '', lines: [], fenced: [], from: 1 }]
  lines.forEach((line, i) => {
    const heading = !fenced[i] && line.match(/^ {0,3}##\s+(.*?)\s*#*\s*$/)
    if (heading) sections.push({ heading: heading[1], lines: [], fenced: [], from: i + 2 })
    else {
      sections.at(-1).lines.push(line)
      sections.at(-1).fenced.push(fenced[i])
    }
  })
  return sections
}

/**
 * Words of prose. Code blocks and tables are not prose and are not counted;
 * lists and block quotes are, since that is where a description's content
 * often is and a bulleted essay is still an essay.
 * @type {(lines: string[], fenced: boolean[]) => number}
 */
const countWords = (lines, fenced) =>
  lines
    .filter((line, i) => !fenced[i] && !/^\s*\|/.test(line))
    .join(' ')
    .split(/\s+/)
    .filter((word) => /[A-Za-z0-9]/.test(word)).length

/**
 * A section with nothing in it. The horizontal rule before Details sits at the
 * end of the last section above it and belongs to neither, so it does not
 * count as content — without that, the section above the rule is the one
 * section that can never be reported empty.
 * @type {(section: {lines: string[]}) => boolean}
 */
const isEmpty = (section) =>
  section.lines.every((line) => line.trim() === '' || /^ {0,3}-{3,}\s*$/.test(line))

/**
 * The lines that look hard-wrapped: long, prose, and with more prose directly
 * underneath. Both halves are needed — a long line at the end of a paragraph
 * is just a paragraph, and a long line above a list is the sentence that
 * introduces it.
 * @type {(lines: string[], fenced: boolean[]) => {number: number, text: string}[]}
 */
const hardWrappedLines = (lines, fenced) => {
  const wrapped = []
  lines.forEach((line, i) => {
    if (fenced[i] || fenced[i + 1]) return
    if (!isProse(line) || !isProse(lines[i + 1] ?? '')) return
    if (line.trimEnd().length < WRAPPED_LINE_COLUMNS) return
    wrapped.push({ number: i + 1, text: line.trim() })
  })
  return wrapped
}

/**
 * Things in a high-level section that are code rather than language. Links are
 * removed before the scan: a url is not a path a reviewer has to go and read,
 * and the standard's list is paths, symbol names, diff snippets and code
 * blocks.
 * @type {(section: {lines: string[], fenced: boolean[]}) => string[]}
 */
const codeInProse = (section) => {
  const found = []
  section.lines.forEach((line, i) => {
    if (section.fenced[i]) {
      if (FENCE.test(line)) found.push('a fenced code block')
      return
    }
    for (const [, span] of line.matchAll(/`([^`]+)`/g)) {
      const looksLikeCode =
        span.includes('/') ||
        span.includes('()') ||
        new RegExp(`\\.(?:${EXTENSIONS})$`).test(span) ||
        /[a-z0-9]_[a-z0-9]/.test(span) ||
        /[a-z][A-Z]/.test(span)
      if (looksLikeCode) found.push(`\`${span}\``)
    }
    const prose = line.replace(/https?:\/\/\S+/g, ' ').replace(/`[^`]*`/g, ' ')
    for (const [path] of prose.matchAll(
      new RegExp(`[\\w.-]*[\\w-](?:\\/[\\w.-]+)*\\.(?:${EXTENSIONS})\\b`, 'g')
    )) {
      found.push(path)
    }
  })
  return [...new Set(found)]
}

/**
 * The number the ceiling is measured against, for a caller that wants to say
 * how close a passing body came.
 * @type {(body: string) => number}
 */
const proseWordCount = (body) => {
  const lines = withoutComments(body ?? '').split(/\r?\n/)
  return countWords(lines, fencedLines(lines))
}

/**
 * Every way this title breaks the rules. An empty array is a pass.
 * @type {(title: string) => string[]}
 */
const checkPrTitle = (title) =>
  TITLE_SHAPE.test((title ?? '').trim())
    ? []
    : [
        `The title "${(title ?? '').trim()}" is not a Conventional Commit. It ` +
          'wants one of feat, fix, refactor, test, docs or chore, an optional ' +
          'scope naming what it touches, then a colon and a space — ' +
          '"feat(db_maintenance): propose English editions for the books".',
      ]

/**
 * Every way this body breaks the rules, as sentences to print. An empty array
 * is a pass.
 * @type {(body: string) => string[]}
 */
const checkPrBody = (body) => {
  const lines = withoutComments(body ?? '').split(/\r?\n/)
  const fenced = fencedLines(lines)
  const sections = sectionsOf(lines, fenced)
  const byHeading = new Map(sections.map((section) => [section.heading, section]))
  const problems = []

  /* The opening sentence, above the first heading. */
  const opening = sections[0]
  if (isEmpty(opening)) {
    problems.push(
      'The body opens straight into a heading, and the line above the first ' +
        'section is the one-sentence summary — what somebody skimming a list ' +
        'of merged pull requests would want to read.'
    )
  } else if (opening.lines.some((line) => line.trim() === TLDR_PLACEHOLDER)) {
    problems.push(
      `The opening line is still the template's "${TLDR_PLACEHOLDER}" ` +
        'placeholder. Replace it with the sentence itself; it renders, so ' +
        'leaving it is visible to everyone who opens the pull request.'
    )
  } else {
    const words = countWords(opening.lines, opening.fenced)
    if (words > SECTION_WORDS['']) {
      problems.push(
        `The opening is ${words} words against a ceiling of ` +
          `${SECTION_WORDS['']}, which is one sentence with room to spare. ` +
          'What does not fit belongs under "## Summary".'
      )
    }
  }

  const present = sections.map((section) => section.heading).filter(Boolean)
  for (const heading of REQUIRED_HEADINGS.filter((h) => !present.includes(h))) {
    problems.push(
      `The body has no "## ${heading}" section. The template in ` +
        '.github/pull_request_template.md has the four the check wants, ' +
        'spelled the way it spells them.'
    )
  }

  const order = present.filter((heading) => REQUIRED_HEADINGS.includes(heading))
  if (order.length === REQUIRED_HEADINGS.length && order.join('\n') !== REQUIRED_HEADINGS.join('\n')) {
    problems.push(
      `The sections run ${order.join(', ')}, and the template has them as ` +
        `${REQUIRED_HEADINGS.join(', ')}.`
    )
  }

  for (const heading of REQUIRED_HEADINGS) {
    const section = byHeading.get(heading)
    if (!section) continue

    if (isEmpty(section)) {
      problems.push(
        `"## ${heading}" is empty. A section with nothing under it is the ` +
          'template submitted rather than filled in; where the true answer is ' +
          '"None." or "no runtime artifact is possible here", write that.'
      )
      continue
    }

    const ceiling = SECTION_WORDS[heading] ?? MAX_SECTION_WORDS
    const words = countWords(section.lines, section.fenced)
    if (words > ceiling) {
      problems.push(
        `"## ${heading}" is ${words} words against a ceiling of ${ceiling}. ` +
          'Cut it rather than moving it down the page: a reviewer wants what ' +
          'the branch does, not how it got there.'
      )
    }
  }

  /* Changes is the one section with a shape rather than just a size. */
  const changes = byHeading.get('Changes')
  if (changes && !isEmpty(changes)) {
    for (const label of ['Before', 'After']) {
      const bullet = changes.lines.find((line) =>
        new RegExp(`^\\s*[-*+]\\s+\\*\\*${label}:?\\*\\*`).test(line)
      )
      if (!bullet) {
        problems.push(
          `"## Changes" has no "**${label}:**" bullet. The section is the two ` +
            'of them and nothing else: what a reader got before, and what ' +
            'they get now.'
        )
      } else if (countWords([bullet.replace(/\*\*[^*]+\*\*/, '')], [false]) < 2) {
        problems.push(`The "**${label}:**" bullet in "## Changes" says nothing after its label.`)
      }
    }
  }

  /* Details is optional, sits below the rule, and is short when it is there. */
  const details = byHeading.get(DETAILS_HEADING)
  if (details) {
    const ruleAbove = lines
      .slice(0, details.from - 2)
      .some((line, i) => !fenced[i] && /^ {0,3}-{3,}\s*$/.test(line))
    if (!ruleAbove) {
      problems.push(
        'There is no horizontal rule above "## Details". The rule is the ' +
          'line between what a skimmer reads and what a verifier reads, and ' +
          'it is deliberate rather than decoration.'
      )
    }

    const bullets = details.lines.filter(
      (line, i) => !details.fenced[i] && /^\s*(?:[-*+]|\d+[.)])\s/.test(line)
    ).length
    if (bullets > MAX_DETAILS_BULLETS) {
      problems.push(
        `"## Details" has ${bullets} bullets, and it is one short paragraph ` +
          `or at most ${MAX_DETAILS_BULLETS}. Link the longer analysis ` +
          'instead of pasting it here.'
      )
    }

    const words = countWords(details.lines, details.fenced)
    if (words > SECTION_WORDS[DETAILS_HEADING]) {
      problems.push(
        `"## Details" is ${words} words against a ceiling of ` +
          `${SECTION_WORDS[DETAILS_HEADING]}. It is for what materially ` +
          'affects review, not for narrating the diff.'
      )
    }
  }

  for (const heading of HIGH_LEVEL) {
    const section = byHeading.get(heading)
    if (!section) continue
    const code = codeInProse(section)
    if (code.length) {
      const where = heading ? `"## ${heading}"` : 'the opening summary'
      problems.push(
        `${where} contains ${code.slice(0, 3).join(', ')}, and everything ` +
          'above the horizontal rule is natural language: no file paths, no ' +
          'symbol names, no code. Say what it does. "## Artifact" is where ' +
          'the paths and the output belong.'
      )
    }
  }

  const placeholder = lines.find((line, i) => !fenced[i] && PLACEHOLDER.test(line))
  if (placeholder) {
    problems.push(
      `A line of the template is still unfilled: "${placeholder.trim()}". ` +
        'Replace what is between the angle brackets, brackets and all.'
    )
  }

  const total = countWords(lines, fenced)
  if (total > MAX_WORDS) {
    problems.push(
      `The body is ${total} words of prose against a ceiling of ${MAX_WORDS}. ` +
        'Code blocks and tables are not counted, so this is all description.'
    )
  }

  const wrapped = hardWrappedLines(lines, fenced)
  if (wrapped.length) {
    problems.push(
      `${wrapped.length} line(s) look hard-wrapped, the first at line ` +
        `${wrapped[0].number}: "${wrapped[0].text}". GitHub renders a single ` +
        'newline in a pull request body as a line break, so a paragraph ' +
        'wrapped at 72 or 80 columns comes out ragged at every window width. ' +
        'Put each paragraph on one long line. Wrapping stays right in commit ' +
        'messages and in .md files in the repo.'
    )
  }

  return problems
}

module.exports = {
  REQUIRED_HEADINGS,
  DETAILS_HEADING,
  TLDR_PLACEHOLDER,
  HIGH_LEVEL,
  MAX_WORDS,
  MAX_SECTION_WORDS,
  SECTION_WORDS,
  MAX_DETAILS_BULLETS,
  WRAPPED_LINE_COLUMNS,
  checkPrBody,
  checkPrTitle,
  proseWordCount,
  countWords,
  fencedLines,
  hardWrappedLines,
}
