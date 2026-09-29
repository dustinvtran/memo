const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')
const assert = require('node:assert/strict')

// Here rather than beside the script because `node --test` does not look
// inside `.github`, so a test there would never run.
const SCRIPT = path.join(__dirname, '..', '.github', 'scripts', 'check_audit.js')

/** Runs the check with `report` on stdin, as CI does with a file. */
const run = (report) =>
  spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(report),
    encoding: 'utf8',
  })

const CLEAN = {
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    dependencies: { prod: 120, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 120 },
  },
}

test('a clean report passes', () => {
  const result = run(CLEAN)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /0 advisories against the 120 packages/)
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
