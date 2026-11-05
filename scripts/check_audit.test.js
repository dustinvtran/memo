const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Here rather than beside the script because `node --test` does not look
// inside `.github`, so a test there would never run.
const SCRIPT = path.join(__dirname, '..', '.github', 'scripts', 'check_audit.js')
const { ACCEPTED, assess } = require(SCRIPT)

/** Runs the check with `report` on stdin, as CI does with a file. */
const run = (report) =>
  spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(report),
    encoding: 'utf8',
  })

/** One high advisory against `name`, shaped as `npm audit --json` writes it. */
const advisory = (name) => ({
  [name]: {
    via: [
      {
        name,
        url: `https://github.com/advisories/GHSA-${name}`,
        severity: 'high',
        range: '<2.0.0',
        title: `An advisory against ${name}`,
      },
    ],
  },
})

// Clean means nothing beyond what ACCEPTED already lists. A report with no
// advisories at all is only clean while that list is empty, because an entry
// nothing reports fails as stale.
const CLEAN = {
  auditReportVersion: 2,
  vulnerabilities: Object.assign({}, ...Object.keys(ACCEPTED).map(advisory)),
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    dependencies: { prod: 120, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 120 },
  },
}

test('a clean report passes', () => {
  const result = run(CLEAN)
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    new RegExp(`${Object.keys(ACCEPTED).length} advisories against the 120 packages`)
  )
})

// Against a list of its own rather than ACCEPTED, which is usually empty: CI
// refuses a skipped test, so this has to run whatever the list holds today.
test('an accepted entry nothing reports any more is stale', () => {
  const accepted = { braces: 'no patched release', leftpad: 'still reported' }
  const report = { ...CLEAN, vulnerabilities: advisory('leftpad') }

  const { stale, unexpected } = assess(report, accepted)

  assert.deepEqual(stale, ['braces'])
  assert.deepEqual(unexpected, [])
})

test('an advisory nothing accepts is unexpected', () => {
  const { stale, unexpected } = assess({ ...CLEAN, vulnerabilities: advisory('leftpad') }, {})

  assert.deepEqual(stale, [])
  assert.deepEqual(unexpected.map((a) => a.package), ['leftpad'])
})

// What `npm audit --json` writes when it cannot reach the registry.
test('a failed audit fails, and says why', () => {
  const result = run({
    error: {
      code: 'ECONNREFUSED',
      summary: 'request to http://127.0.0.1:9/-/npm/v1/security/advisories/bulk failed',
      detail: '',
    },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /did not produce a report/)
  assert.match(result.stderr, /ECONNREFUSED/)
})

test('an empty object fails rather than reading as no advisories', () => {
  const result = run({})
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no `metadata.dependencies`/)
})

test('an error fails even beside an otherwise clean report', () => {
  const result = run({ ...CLEAN, error: { code: 'E429', summary: 'rate limited' } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /E429/)
})

test('a new high advisory still fails', () => {
  const result = run({
    ...CLEAN,
    vulnerabilities: {
      leftpad: {
        via: [
          {
            name: 'leftpad',
            url: 'https://github.com/advisories/GHSA-test',
            severity: 'high',
            range: '<2.0.0',
            title: 'Pads to the right',
          },
        ],
      },
    },
  })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /NEW\s+leftpad/)
})
