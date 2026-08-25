/**
 * @file A past version of an entry (`kind: 'revision'`), or the unsaved
 * edit-in-progress the form autosaves (`kind: 'draft'`).
 */
const { z } = require('zod')
const { validate } = require('./utils')

/**
 * The user-editable half of an entry, plus the review text, which lives in
 * its own collection but is the field most worth being able to recover.
 * Unknown keys are dropped by zod, so a form that sends more than this can't
 * grow the history documents.
 */
const snapshotParser = z.object({
  status: z.string().optional(),
  score: z.number().nullable().optional(),
  startedDate: z.number().nullable().optional(),
  completedDate: z.number().nullable().optional(),
  progress: z.number().nullable().optional(),
  workRef: z.string().nullable().optional(),
  // Both halves named, because zod 4 reads a lone argument as the *key*
  // schema rather than the value's. `z.record(z.any())` still builds and
  // still accepts an object — it just stops checking anything, quietly.
  overrides: z.record(z.string(), z.any()).nullable().optional(),
  review: z.string().optional(),
})

const entryRevisionParser = z.object({
  entryRef: z.string(),
  entryType: z.enum(['films', 'books', 'tv', 'games']),
  userId: z.string(),
  kind: z.enum(['revision', 'draft']),
  /** When this version was saved (for a draft: when it was last autosaved). */
  createdDate: z.number(),
  /** When a later save replaced it. Absent on drafts. */
  supersededDate: z.number().optional(),
  snapshot: snapshotParser,
})

/** @typedef {z.infer<typeof entryRevisionParser>} EntryRevision */

/** @type Validator<EntryRevision> */
const entryRevisions = (x) => validate(entryRevisionParser, x)

/** @type Validator<any> */
const snapshot = (x) => validate(snapshotParser, x)

module.exports = {
  entryRevisions,
  snapshot,
}
