/** @typedef {import('./works').Work} Work */
/**
 * @template T
 * @typedef {import('./utils').Validator<T>} Validator
 */
import { workParser } from './works.js'
import { validate } from './utils.js'
import { z } from 'zod'
import { entryParser, entryUpdateParser } from './entries.js'
/**
 * Where a game's `duration` was measured, and the key zod dropped on the floor
 * for as long as it went undeclared here.
 *
 * `retrieve` in ../external_api_adapters/games/igdb.js returns `duration` and
 * `durationSource` together or returns neither, `_create` parses a document
 * before inserting it, and a `z.object` does not keep a key it was not told
 * about. So the pair came apart at the last step before the write, and every
 * game added through the site since the IGDB switch was stored as though its
 * playtime were a legacy HowLongToBeat one.
 *
 * That is not a cosmetic loss: the two are different measurements. IGDB's
 * `normally` runs about 1.36x HowLongToBeat's `gameplayMain`
 * (docs/API_choices.md), and telling them apart is the whole job of this
 * field — `toPlaytimeUrl` in ../../../frontend/_includes/js/utils/columns.js
 * links a playtime to the source that measured it, `mergeWork` in
 * ../../../db_maintenance/work_metadata_merge.js refuses to refresh a
 * duration from a source other than the one that wrote it, and
 * ../../../db_maintenance/scripts/backfill_game_playtimes.js counts what it
 * has filled by it.
 *
 * `'igdb'` and nothing else, because *absent* is the other value: it means the
 * playtime predates the field and came from HowLongToBeat. Every reader listed
 * above tests `=== 'igdb'` and reads anything else as HowLongToBeat, so a
 * third spelling would be quietly misread rather than noticed — the same
 * silence this field has just been dug out of. `DURATION_SOURCE` in
 * ../external_api_adapters/games/time_to_beat.js is what writes it, and
 * ./parsers.test.js is what holds the two spellings together.
 *
 * Games alone: a film's runtime and a book's page count have one source each
 * and never carried this, which is why it sits here rather than on
 * `workParser` beside the `duration` it describes.
 */
const durationSourceParser = z.literal('igdb')

const gameParser = workParser.extend({
  entryType: z.literal('Game'),
  durationSource: durationSourceParser.optional(),
  platforms: z.array(z.string()).nullable().optional(),
  studios: z.array(z.string()).nullable().optional(),
  publishers: z.array(z.string()).nullable().optional(),
})

/** @typedef {z.infer<typeof gameParser>} Game */

const gameEntryParser = entryParser(gameParser)

/** @typedef {z.infer<typeof gameEntryParser>} GameEntry */

/** @type Validator<GameEntry> */
const gameEntries = (x) => validate(gameEntryParser, x)

const gameEntryUpdateParser = entryUpdateParser(gameParser)

/** The fields a PATCH may set; see `entryUpdateParser`. */
/** @type Validator<Partial<GameEntry>> */
const gameEntryUpdates = (x) => validate(gameEntryUpdateParser, x)

/** @type Validator<Game> */
const games = (x) => validate(gameParser, x)

export {
  gameEntries,
  gameEntryUpdates,
  games,
}