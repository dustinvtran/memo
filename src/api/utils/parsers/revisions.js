/**
 * @file A past version of an entry (`kind: 'revision'`), or the unsaved
 * edit-in-progress the form autosaves (`kind: 'draft'`).
 */
import { z } from 'zod'
import { validate } from './utils.js'
import { entryTypeParser } from './works.js'
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
  /**
   * The same spelling a work document carries — 'Film', not the 'films' of
   * the url. One field name, one enum, one meaning: until #220 this said
   * `z.enum(['films', 'books', 'tv', 'games'])` while every work said
   * `z.enum(['Game', 'Film', 'TVShow', 'Book'])`, and nothing converted
   * between them because nothing knew there was anything to convert.
   */
  entryType: entryTypeParser,
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

export {
  entryRevisions,
  snapshot,
}