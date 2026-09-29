/**
 * @file The shape of an API token, with no install: `api_token.js` imports
 * only `node:crypto`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  API_TOKEN_PREFIX,
  generateApiToken,
  isApiToken,
  looksLikeApiToken,
  hashApiToken,
  MAX_API_TOKEN_LIFETIME_SECONDS,
  LAST_USED_RESOLUTION_MS,
  expiresAtOf,
  isExpired,
  shouldRecordUse,
} from './api_token.js'

test('a generated token is prefixed, the right length and never repeats', () => {
  const minted = new Set(Array.from({ length: 100 }, generateApiToken))

  assert.equal(minted.size, 100)
  for (const token of minted) {
    assert.ok(token.startsWith(API_TOKEN_PREFIX))
    assert.ok(isApiToken(token), token)
  }
})

test('the hash is stable, hex, and not the token', () => {
  const token = generateApiToken()

  assert.equal(hashApiToken(token), hashApiToken(token))
  assert.match(hashApiToken(token), /^[0-9a-f]{64}$/)
  assert.notEqual(hashApiToken(token), hashApiToken(generateApiToken()))
})

test('a session token is not mistaken for an API token', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl'

  assert.equal(isApiToken(jwt), false)
  assert.equal(looksLikeApiToken(jwt), false)
})

test('a mangled API token still looks like one, and is not one', () => {
  const truncated = generateApiToken().slice(0, -1)

  assert.equal(looksLikeApiToken(truncated), true)
  assert.equal(isApiToken(truncated), false)
  assert.equal(isApiToken(undefined), false)
})

test('the longest lifetime a token may be given stays exact in milliseconds', () => {
  assert.ok(Number.isSafeInteger(Date.now() + MAX_API_TOKEN_LIFETIME_SECONDS * 1000))
})

test('a stored expiresAt is the answer, and a null or missing one is never', () => {
  assert.equal(expiresAtOf({ createdAt: 1000, expiresAt: 5000 }), 5000)
  assert.equal(expiresAtOf({ createdAt: 1000, expiresAt: null }), null)
  assert.equal(expiresAtOf({ createdAt: 1000 }), null)
})

test('a token is expired from its expiresAt onward, and one with none never is', () => {
  const stored = { createdAt: 0, expiresAt: 5000 }

  assert.equal(isExpired(stored, 4999), false)
  assert.equal(isExpired(stored, 5000), true)
  assert.equal(isExpired({ createdAt: 0, expiresAt: null }, Number.MAX_SAFE_INTEGER), false)
  assert.equal(isExpired({ createdAt: 0 }, Number.MAX_SAFE_INTEGER), false)
})

test('a use is recorded the first time and then once per resolution', () => {
  assert.equal(shouldRecordUse({}, 0), true)
  assert.equal(shouldRecordUse({ lastUsedAt: 0 }, LAST_USED_RESOLUTION_MS - 1), false)
  assert.equal(shouldRecordUse({ lastUsedAt: 0 }, LAST_USED_RESOLUTION_MS), true)
})
