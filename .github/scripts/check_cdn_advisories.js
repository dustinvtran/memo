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
 * The versions are written down in exactly one place — as `integrity`-carrying
 * `<script>` and `<link>` tags in `layouts/base.njk`, which is what #106 left
 * behind — so this parses that file rather than keeping a list that can drift,
 * and asks registry.npmjs.org what is known against each. No install and no
 * token: the bulk advisory endpoint is a plain POST.
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

/** The one file that names a version, relative to the repo root. */
const SOURCE = 'src/frontend/_includes/layouts/base.njk'

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
  jquery:
    '1.11.1, from 2014, carries three moderate XSS. 1.12.2 clears one of ' +
    'them for almost nothing and is worth taking on its own; the other two ' +
    'need 3.5.0, and jQuery 1.x to 3.x is not a drop-in. #218.',
  bootstrap:
    '3.3.1 carries seven moderate XSS, every one of them in `data-*` ' +
    'attribute handling and every one fixed on the 3.4 line rather than ' +
    'needing 5.x. Bootstrap 3 to 5 rewrites the markup and is its own ' +
    'change. `bootstrap-table` is pinned to match, so the two move ' +
    'together. #218.',
  'bootstrap-table':
    'Pinned at 1.12.1 to match Bootstrap 3, so it cannot move ahead of the ' +
    'entry above. One moderate and one low XSS. #218.',
  axios:
    '0.24.0 is a long way behind and carries several high, including SSRF ' +
    'and prototype pollution. The frontend calls same-origin `/api` with no ' +
    'proxy and no redirects, which is not where most of these land, but it ' +
    'is a bump worth taking on its own. #218. Not to be confused with the ' +
    '`axios` in check_audit.js: that is a different copy, nested under ' +
    'igdb-api-node and server-side, and no bump to this tag touches it.',
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
 * The pinned name and version behind every CDN url in `base.njk`.
 *
 * Only tags carrying `integrity`: that attribute is the marker of a pinned
 * third-party url, and keying on it keeps the site's own content-hashed `/js`
 * and `/css` links out without naming them. Both CDN shapes in the file are
 * matched:
 *
 *   cdnjs     .../ajax/libs/<library>/<version>/<file>
 *   jsDelivr  .../npm/<package>@<version>[/<file>]
 *
 * A url that carries `integrity` and matches neither is a hard failure rather
 * than a skip, because quietly ignoring one is how a library ends up unwatched
 * — which is the situation this whole file exists to end.
 */
const parsePins = (text) => {
  const pins = new Map()
  const unrecognised = []

  for (const tag of text.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
    if (!/\sintegrity=/.test(tag)) continue
    const url = tag.match(/\s(?:src|href)="([^"]+)"/)?.[1]
    if (!url) continue

    const cdnjs = url.match(
      /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/([^/]+)\/([^/]+)\//
    )
    const jsdelivr = url.match(
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)/
    )
    const matched = cdnjs ?? jsdelivr
    if (!matched) {
      unrecognised.push(url)
      continue
    }

    const [, library, version] = matched
    const name = cdnjs ? (NPM_NAME[library] ?? library) : library
    /* Two tags for one library — Bootstrap's CSS and its JS — are one pin. */
    pins.set(`${name}@${version}`, { name, version, url })
  }

  return { pins: [...pins.values()], unrecognised }
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
  const { pins, unrecognised } = parsePins(
    fs.readFileSync(path.join(root, SOURCE), 'utf8')
  )

  if (unrecognised.length) {
    console.log(`These urls in ${SOURCE} are pinned and hashed, but this check`)
    console.log('cannot read a package and a version out of them, so nothing is')
    console.log(`watching them. Teach parsePins the shape, in ${SELF}:`)
    for (const url of unrecognised) console.log(`  ${url}`)
    process.exit(1)
  }
  if (!pins.length) {
    console.log(`Found no pinned CDN urls in ${SOURCE} at all, which cannot be`)
    console.log('right: the parser and the file have stopped matching, and a')
    console.log('check over nothing passes every time.')
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
    `${pins.length} pinned CDN libraries in ${SOURCE}; npm reports against ${affected.size}.`
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
    console.log(`Bump the version in ${SOURCE} and recompute its \`integrity\` —`)
    console.log('the recipe is in the comment at the top of that file — or, if it')
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
