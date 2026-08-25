import { z } from 'zod'
const entryTypeParser = z.enum(['Game', 'Film', 'TVShow', 'Book'])
// const apiRefParser = z.object({
  // name: z.string(),
  // ref: z.string(),
// })
const externalUrlParser = z.object({
  name: z.string(),
  url: z.string(),
})

const workParser = z.object({
  apiRefs: z.array(z.string()),
  externalUrls: z.array(externalUrlParser).nullable().optional(),
  entryType: entryTypeParser,
  englishTranslatedTitle: z.string().nullable(),
  originalTitle: z.string().nullable().optional(),
  releaseYear: z.number().nullable().optional(),
  duration: z.number().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  genres: z.array(z.string()).nullable().optional(),
})

/** @typedef {z.infer<typeof workParser>} Work */

export {
  workParser
}