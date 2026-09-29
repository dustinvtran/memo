/**
 * @file The scheme of an `Authorization` header, with no install.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearerCredential } from './bearer.js'

test('the Bearer scheme is matched whatever its case', () => {
  for (const scheme of ['Bearer', 'bearer', 'BEARER', 'bEaReR']) {
    assert.equal(bearerCredential(`${scheme} memo_pat_x`), 'memo_pat_x', scheme)
  }
})

test('only a leading scheme is taken off', () => {
  assert.equal(bearerCredential('memo_pat_x'), 'memo_pat_x')
  assert.equal(bearerCredential('Basic abc'), 'Basic abc')
  assert.equal(bearerCredential('Bearerabc'), 'Bearerabc')
  assert.equal(bearerCredential('x Bearer y'), 'x Bearer y')
})
