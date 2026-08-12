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
  status: z.string().or(z.undefined()),
  score: z.number().nullable().or(z.undefined()),
  startedDate: z.number().nullable().or(z.undefined()),
  completedDate: z.number().nullable().or(z.undefined()),
  progress: z.number().nullable().or(z.undefined()),
  workRef: z.string().nullable().or(z.undefined()),
  overrides: z.record(z.any()).nullable().or(z.undefined()),
  review: z.string().or(z.undefined()),
})

const entryRevisionParser = z.object({
  entryRef: z.string(),
  entryType: z.enum(['films', 'books', 'tv', 'games']),
  userId: z.string(),
  kind: z.enum(['revision', 'draft']),
  /** When this version was saved (for a draft: when it was last autosaved). */
  createdDate: z.number(),
  /** When a later save replaced it. Absent on drafts. */
  supersededDate: z.number().or(z.undefined()),
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
