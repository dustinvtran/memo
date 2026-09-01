/**
 * @file Fails the build on a *new* advisory against the libraries the pages
 * load from a CDN.
 *
 * `check_audit.js` beside this one reads `npm audit`, which reads
 * `package.json` — and every script and stylesheet the site actually runs in a
 * browser is loaded from cdnjs or jsDelivr instead, so none of them are in that
 * report and nothing in this repo could see them. #218 is what that blindness
 * had accumulated: seven of the nine carried published advisories, one of them
 * critical, against a page that holds the reader's `nf_jwt`.
 *
 * The versions are written down where the browser is told to fetch them and
 * nowhere else — as `integrity`-carrying `<script>` and `<link>` tags in
 * `layouts/base.njk`, which is what #106 left behind, and as the pinned
 * constants in `js/utils/load_script.js` for the one library that is fetched
 * on demand rather than by a tag. So this parses those files rather than
 * keeping a list that can drift, and asks registry.npmjs.org what is known
 * against each. No install and no token: the bulk advisory endpoint is a plain
 * POST.
 *
 * Both files are read because this check counts what it finds and fails on
 * nothing else. A pin that moved somewhere it could not see would not have
 * failed anything: the count would have gone from 8 to 7, quietly, and that
 * library would be unwatched — which is the situation this whole file exists
 * to end. #269 moved the first one, so the second source is not hypothetical.
 *
 * SRI answers a different question, and it is worth being clear about which.
 * `integrity` guarantees the bytes are the bytes that version published. It
 * says nothing about whether that version is one anybody should be running.
 * This is the other half.
 *
 * **Accepting something here is not fixing it.** An entry in ACCEPTED is a note
 * that the advisory has been read and is tracked, and it should be deleted the
 * moment the upgrade lands — which is enforced below, since a name listed that
 * is no longer reported against fails too.
 */

const fs = require('node:fs')
const path = require('node:path')

/**
 * The files that name a version, relative to the repo root, each with the way
 * a pinned url is written in it. The two readers are wrapped rather than named
 * because they are defined below this, and this list is built as the file is
 * read.
 */
const SOURCES = [
  {
    path: 'src/frontend/_includes/layouts/base.njk',
    pinnedUrls: (text) => urlsInMarkup(text),
  },
  {
    path: 'src/frontend/_includes/js/utils/load_script.js',
    pinnedUrls: (text) => urlsInScript(text),
  },
]

/** This file, for the messages that tell a reader where to come and edit. */
const SELF = `.github/scripts/${path.basename(__filename)}`

/**
 * cdnjs library name -> npm package name, where the two differ.
 *
 * This is the trap the whole check turns on: the bulk endpoint answers an
 * unknown package with silence rather than an error, so a wrong name here
 * reads exactly like a clean bill of health. cdnjs's `font-awesome` is the
 * live example — npm's `font-awesome` stopped at 4.7.0, and the 6.x this site
 * loads is published as `@fortawesome/fontawesome-free`, so asking npm about
 * `font-awesome@6.7.2` gets a 404 that would otherwise pass for "nothing
 * reported". `resolves()` below is what turns that back into a failure.
 */
const NPM_NAME = {
  'twitter-bootstrap': 'bootstrap',
  'font-awesome': '@fortawesome/fontawesome-free',
}

/** Package name -> why an advisory against it does not stop the build today. */
const ACCEPTED = {
  bootstrap:
    'Only the stylesheet is loaded now, and both advisories reported ' +
    'against 3.4.1 need JavaScript that is no longer on the page: ' +
    'CVE-2024-6485 is `data-loading-text` in the button plugin and ' +
    'CVE-2025-1647 is popover and tooltip, and `bootstrap.min.js` left ' +
    'with jQuery in #269 step 5. Neither has a patched release anywhere ' +
    'on the 3.x line in any case. The stylesheet is step 6. #254, #269.',
}

/**
 * Severities that stop the build.
 *
 * `check_audit.js` draws this line at high, and is right to — those are
 * transitive server-side packages where a moderate is usually a
 * denial-of-service in a code path nothing reaches. These are not that. Every
 * advisory against this set is XSS, on a page holding a 14-day session token
 * that any script running there can read, so a moderate here is the shape of
 * thing a critical is there. Low stays off the list: both of the ones reported
 * today need a configuration this site does not pass, and a check that fails
 * on those is a check that gets ignored.
 */
const BLOCKING = new Set(['moderate', 'high', 'critical'])

/**
 * Every pinned url in `base.njk`: the `src` or `href` of a tag carrying
 * `integrity`.
 *
 * That attribute is the marker of a pinned third-party url, and keying on it
 * keeps the site's own content-hashed `/js` and `/css` links out without
 * naming them.
 */
const urlsInMarkup = (text) => ({
  urls: (text.match(/<(?:script|link)\b[^>]*>/g) ?? [])
    .filter((tag) => /\sintegrity=/.test(tag))
    .map((tag) => tag.match(/\s(?:src|href)="([^"]+)"/)?.[1])
    .filter(Boolean),
  unhashed: [],
})

/**
 * Every pinned url in a module that injects its own tag: a `url` in an object
 * literal, immediately followed by the `integrity` it is loaded with.
 *
 * Adjacency is the rule, and it is the same rule as above — a url is watched
 * here because it is hashed, and the two belong to each other. A CDN url in
 * that file that is *not* half of such a pair is reported rather than skipped:
 * an unhashed third-party script is both unverified and unwatched, and this is
 * the only place either would be noticed.
 *
 * Comments go first, so that a url quoted in one is neither of those things.
 */
const urlsInScript = (text) => {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const urls = [
    ...code.matchAll(/\burl:\s*'([^']+)'\s*,\s*integrity:\s*'[^']+'/g),
  ].map(([, url]) => url)

  const hashed = new Set(urls)
  const unhashed = [...code.matchAll(/'(https:\/\/[^']+)'/g)]
    .map(([, url]) => url)
    .filter((url) => !hashed.has(url))

  return { urls, unhashed }
}

/**
 * The pinned name and version behind one CDN url. Both shapes are matched:
 *
 *   cdnjs     .../ajax/libs/<library>/<version>/<file>
 *   jsDelivr  .../npm/<package>@<version>[/<file>]
 *
 * A pinned url matching neither is a hard failure rather than a skip, because
 * quietly ignoring one is how a library ends up unwatched — which is the
 * situation this whole file exists to end.
 */
const toPin = (url) => {
  const cdnjs = url.match(
    /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/([^/]+)\/([^/]+)\//
  )
  const jsdelivr = url.match(
    /^https:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)/
  )
  const matched = cdnjs ?? jsdelivr
  if (!matched) return undefined

  const [, library, version] = matched
  const name = cdnjs ? (NPM_NAME[library] ?? library) : library
  return { name, version, url }
}

/**
 * Every pin in every source, deduplicated.
 *
 * `empty` is per source rather than over the total: each of these files is
 * supposed to pin something, so one of them going quiet is the parser and the
 * file having stopped matching — and a check over nothing passes every time.
 */
const readPins = (root) => {
  const pins = new Map()
  const unrecognised = []
  const unhashed = []
  const empty = []

  for (const { path: source, pinnedUrls } of SOURCES) {
    const found = pinnedUrls(fs.readFileSync(path.join(root, source), 'utf8'))
    unhashed.push(...found.unhashed.map((url) => ({ url, source })))

    let count = 0
    for (const url of found.urls) {
      const pin = toPin(url)
      if (!pin) {
        unrecognised.push({ url, source })
        continue
      }
      /* Two tags for one library — Bootstrap's CSS and its JS — are one pin. */
      pins.set(`${pin.name}@${pin.version}`, pin)
      count += 1
    }
    if (count === 0) empty.push(source)
  }

  return { pins: [...pins.values()], unrecognised, unhashed, empty }
}

/** Whether npm has this exact version, so that a bad NPM_NAME cannot pass. */
const resolves = async ({ name, version }) => {
  const response = await fetch(
    `https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`
  )
  return response.ok
}

/**
 * name -> advisories, from the endpoint the npm client itself uses.
 *
 * A package nothing is reported against is absent from the answer rather than
 * present and empty, so the keys are the affected set.
 */
const fetchAdvisories = async (pins) => {
  const query = {}
  for (const { name, version } of pins) (query[name] ??= []).push(version)

  const response = await fetch(
    'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(query),
    }
  )
  if (!response.ok) {
    throw new Error(
      `the npm advisory endpoint answered ${response.status} ${response.statusText}`
    )
  }

  const body = await response.json()
  return Object.fromEntries(
    Object.entries(body).filter(([, own]) => own?.length)
  )
}

const worstOf = (advisories) =>
  ['critical', 'high', 'moderate', 'low'].find((severity) =>
    advisories.some((a) => a.severity === severity)
  ) ?? 'none'

const main = async () => {
  const root = path.resolve(__dirname, '..', '..')
  const { pins, unrecognised, unhashed, empty } = readPins(root)

  if (unrecognised.length) {
    console.log('These urls are pinned and hashed, but this check cannot read a')
    console.log('package and a version out of them, so nothing is watching them.')
    console.log(`Teach toPin the shape, in ${SELF}:`)
    for (const { url, source } of unrecognised) {
      console.log(`  ${url}`)
      console.log(`    in ${source}`)
    }
    process.exit(1)
  }
  if (unhashed.length) {
    console.log('These CDN urls carry no integrity hash beside them, so the')
    console.log('browser runs whatever the host serves and this check cannot')
    console.log('see the version either. Pin and hash them where they load:')
    for (const { url, source } of unhashed) {
      console.log(`  ${url}`)
      console.log(`    in ${source}`)
    }
    process.exit(1)
  }
  if (empty.length) {
    console.log('Found no pinned CDN urls at all in these, which cannot be right:')
    console.log('the parser and the file have stopped matching, and a check over')
    console.log('nothing passes every time.')
    for (const source of empty) console.log(`  ${source}`)
    process.exit(1)
  }

  const unknown = []
  for (const pin of pins) if (!(await resolves(pin))) unknown.push(pin)
  if (unknown.length) {
    console.log('npm has no such package at that version, so the advisory')
    console.log('endpoint would answer "nothing reported" whatever the truth')
    console.log(`is. Fix the name in NPM_NAME in ${SELF}:`)
    for (const { name, version, url } of unknown) {
      console.log(`  ${name}@${version}`)
      console.log(`    from ${url}`)
    }
    process.exit(1)
  }

  const advisories = await fetchAdvisories(pins)

  const affected = new Set(Object.keys(advisories))
  const unexpected = Object.entries(advisories)
    .filter(([name]) => !(name in ACCEPTED))
    .flatMap(([name, own]) =>
      own
        .filter((a) => BLOCKING.has(a.severity))
        .map((a) => ({ ...a, package: name }))
    )
    .sort((a, b) => a.package.localeCompare(b.package))
  const stale = Object.keys(ACCEPTED).filter((name) => !affected.has(name))

  console.log(
    `${pins.length} pinned CDN libraries in ${SOURCES.map((s) => s.path).join(
      ' and '
    )}; npm reports against ${affected.size}.`
  )
  console.log('`known` is listed below in ACCEPTED; `NEW` is not and is at')
  console.log('moderate or above; unmarked is not listed but is under that line.')
  console.log('')
  const byName = [...pins].sort((a, b) => a.name.localeCompare(b.name))
  for (const { name, version } of byName) {
    const own = advisories[name] ?? []
    const mark = name in ACCEPTED ? 'known' : BLOCKING.has(worstOf(own)) ? 'NEW' : ''
    console.log(
      `  ${mark.padStart(5)}  ${`${name}@${version}`.padEnd(38)} ${String(
        own.length
      ).padStart(2)} (worst: ${worstOf(own)})`
    )
  }

  if (stale.length) {
    console.log('')
    console.log('Nothing is reported against these any more, so their entries in')
    console.log(`${SELF} are out of date and should be deleted:`)
    for (const name of stale) console.log(`  ${name}`)
  }

  if (unexpected.length) {
    console.log('')
    console.log('New advisories, at moderate or above, against a library every')
    console.log('page loads:')
    for (const a of unexpected) {
      console.log(`  ${a.package} ${a.vulnerable_versions} — ${a.severity}`)
      console.log(`    ${a.title}`)
      console.log(`    ${a.url}`)
    }
    console.log('')
    console.log('Bump the version where it is pinned and recompute the hash')
    console.log('beside it — the recipe is in the comment there — or, if it')
    console.log(`cannot be bumped yet, add it to ACCEPTED in ${SELF} with the`)
    console.log('reason and the issue tracking it, and say so in the pull request.')
  }

  if (unexpected.length || stale.length) process.exit(1)
  console.log('')
  console.log('Nothing new at moderate or above, and nothing listed that has gone away.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
