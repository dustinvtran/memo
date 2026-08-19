/**
 * @file Fails the build on a *new* advisory against anything that ships.
 *
 * Reads `npm audit --omit=dev --json` on stdin. Every package named below is
 * one this repo already knows about and is tracking; anything else at high or
 * critical is new, and new is the only thing worth stopping a build for.
 *
 * Why not just `npm audit --audit-level=high`, which is one line: it exits 1
 * on the eleven advisories the production tree carries today, so it would be
 * red on the commit that added it and red on every commit after, which is the
 * same as having no check at all. The list below is what makes it green now
 * and red the day something arrives.
 *
 * Why `--omit=dev`: `netlify-cli` is a few thousand packages of build tooling
 * and it accounts for 83 of the 118 advisories GitHub reports on this repo,
 * including the only critical one. None of it is reachable from a route, none
 * of it can be fixed without replacing `netlify-cli`, and its tree shifts on
 * its own, so gating on it would mean editing this file for reasons that have
 * nothing to do with the site. The trade is deliberate: a compromised dev
 * dependency is a real risk, and this check will not see it.
 *
 * **Accepting something here is not fixing it.** An entry is a note that the
 * advisory has been read and is tracked somewhere, and it should be deleted
 * the moment the upgrade lands — which is enforced below, since a name that
 * no longer appears in the report fails too.
 */

/** Package name -> why an advisory against it does not stop the build today. */
const ACCEPTED = {
  axios:
    'apicalypse pins axios ^0.21.1, and apicalypse is igdb-api-node\'s. ' +
    'The top-level axios is 1.19.0 and clean — every one of these is the ' +
    'nested copy, which no bump to our own dependency can reach. #182.',
  'html-minifier':
    'Build-time only, in .eleventy.js; unmaintained since 2019 and there ' +
    'will be no fix. The move is to html-minifier-terser. #182.',
  'http-cache-semantics': 'Under got, under node-themoviedb. #182.',
  'js-yaml': 'Under gray-matter, which is Eleventy\'s front matter. Build-time only. #182.',
  got: 'node-themoviedb pins got ^11.8.2. #182.',
  uuid: 'Under better-queue, under node-themoviedb. #182.',
  validator: 'Direct, and a routine bump — 13.7.0 to 13.15.x. #182.',
  zod: 'Direct, and a routine bump — 3.2.0 to the end of the 3.x line. #182.',
}

/** Severities that stop the build. Matches `--audit-level=high`. */
const BLOCKING = new Set(['high', 'critical'])

const read = (stream) =>
  new Promise((resolve, reject) => {
    let text = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => (text += chunk))
    stream.on('end', () => resolve(text))
    stream.on('error', reject)
  })

const main = async () => {
  const report = JSON.parse(await read(process.stdin))

  /* `via` holds either an advisory or the name of the dependency that brought
     one in. Only the objects are advisories, and the same one appears under
     every package it reaches, so they are collected by url rather than counted. */
  const advisories = new Map()
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via === 'string') continue
      advisories.set(via.url, { ...via, package: via.name })
    }
  }

  const affected = new Set([...advisories.values()].map((a) => a.package))
  const unexpected = [...advisories.values()]
    .filter((a) => BLOCKING.has(a.severity) && !(a.package in ACCEPTED))
    .sort((a, b) => a.package.localeCompare(b.package))
  const stale = Object.keys(ACCEPTED).filter((name) => !affected.has(name))

  console.log(
    `${advisories.size} advisories against the ${
      report.metadata?.dependencies?.prod ?? '?'
    } packages that ship, over ${affected.size} of them.`
  )
  console.log('`known` is listed below in ACCEPTED; `NEW` is not and is at high')
  console.log('or above; unmarked is not listed but is under that line.')
  console.log('')
  for (const name of [...affected].sort()) {
    const own = [...advisories.values()].filter((a) => a.package === name)
    const worst = own.some((a) => a.severity === 'critical')
      ? 'critical'
      : own.some((a) => a.severity === 'high')
        ? 'high'
        : own[0].severity
    const mark =
      name in ACCEPTED ? 'known' : BLOCKING.has(worst) ? 'NEW' : ''
    console.log(
      `  ${mark.padStart(5)}  ${name.padEnd(22)} ${String(own.length).padStart(2)} (worst: ${worst})`
    )
  }

  if (stale.length) {
    console.log('')
    console.log('Nothing is reported against these any more, so their entries')
    console.log('in .github/scripts/check_audit.js are out of date and should')
    console.log('be deleted:')
    for (const name of stale) console.log(`  ${name}`)
  }

  if (unexpected.length) {
    console.log('')
    console.log('New advisories, at high or above, against packages that ship:')
    for (const a of unexpected) {
      console.log(`  ${a.package} ${a.range} — ${a.severity}`)
      console.log(`    ${a.title}`)
      console.log(`    ${a.url}`)
    }
    console.log('')
    console.log('Upgrade the package, or — if it cannot be upgraded yet — add it')
    console.log('to ACCEPTED in .github/scripts/check_audit.js with the reason and')
    console.log('the issue tracking it, and say so in the pull request.')
  }

  if (unexpected.length || stale.length) process.exit(1)
  console.log('')
  console.log('Nothing new at high or above, and nothing listed that has gone away.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
