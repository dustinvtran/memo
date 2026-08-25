/** @typedef {import('mongodb').Db} Db */
/** @typedef {import('mongodb').ClientSession} ClientSession */
const { MongoClient, ServerApiVersion } = require('mongodb')
const { throwIt, warn } = require('../general')

/**
 * The client every query here runs through, built on first use rather than
 * on import.
 *
 * Building it eagerly is what used to force the controller tests to
 * intercept `require('mongodb')` itself: by the time a test held this module
 * the real client already existed, so there was no seam left and patching
 * `Module._load` was the only way in. That patch is why the suite could not
 * move to ES modules, which have no such hook — see `docs/module_system.md`.
 * Deferring construction leaves an ordinary seam, and `useClient` below is
 * it.
 *
 * The other half of the change is when a missing `MONGODB_URL` is noticed.
 * It used to throw while this module was being read, so a route that never
 * queried anything still failed to load; now it throws on the first query,
 * which is the request that actually cannot be served.
 *
 * @type {MongoClient | undefined}
 */
let client

/** @type {() => MongoClient} */
const getClient = () =>
  (client ??= new MongoClient(
    process.env.MONGODB_URL ?? throwIt('MONGODB_URL not set'),
    { serverApi: ServerApiVersion.v1 }
  ))

/** @type {Db | undefined} */
let mdb

/**
 * Hand this module a client to use instead of building one. The suite is the
 * only caller — an in-memory fake standing in for a deployment — and nothing
 * in `src/api` calls it at all.
 *
 * It drops the cached database with it, so a test file that hands over a
 * fresh store gets a fresh connection to go with it rather than the previous
 * file's.
 *
 * @type {(replacement: any) => void}
 */
const useClient = (replacement) => {
  client = replacement
  mdb = undefined
  available = undefined
}

/** @type {<T>(query: (db: Db) => Promise<T>) => Promise<T>} */
const mongo = async (query) => {
  if (mdb === undefined) {
    await getClient().connect()
    mdb = getClient().db('memo')
  }

  return query(mdb)
}

/**
 * Runs `work` inside a transaction, so a group of writes either all land or
 * none of them do. Every function this folder exports takes the session as an
 * optional last argument, and a write made without it is not part of the
 * transaction — it will not be rolled back with one, and inside one it will
 * not see what the transaction has written so far.
 *
 * Transactions need a replica set or a sharded cluster. Atlas is a replica
 * set, and Atlas is what production and a local `netlify dev` both talk to,
 * so this is a real transaction wherever the app actually runs. A standalone
 * `mongod` cannot do them at all; rather than refuse to save against one,
 * `work` runs there with no session, which is the behaviour that predates
 * this function — the writes happen in order, and a failure part-way leaves
 * them half-applied. The warning below says so, once per process.
 *
 * @type {<T>(work: (session?: ClientSession) => Promise<T>) => Promise<T>}
 */
const withTransaction = async (work) => {
  if (!(await transactionsAvailable())) return work(undefined)

  // The driver may run the callback more than once when the server asks for a
  // retry, and hands back what the run that committed returned — so `work`
  // must stay safe to repeat, but the result needs no catching on the side.
  return getClient().withSession((session) =>
    session.withTransaction(() => work(session))
  )
}

module.exports = {
  mongo,
  withTransaction,
  useClient,
}

///////////////////////////////////////////////////////////////////////////////

/** @type {boolean | undefined} */
let available

/**
 * Asked once and remembered for the life of the container: a deployment does
 * not become a replica set while it is being talked to.
 * @type {() => Promise<boolean>}
 */
const transactionsAvailable = async () => {
  if (available === undefined) {
    available = await mongo(async (db) => {
      // `hello` is the handshake every deployment answers. `setName` is only
      // there on a replica set member, and `isdbgrid` is a mongos.
      const hello = await db.admin().command({ hello: 1 })
      return Boolean(hello.setName) || hello.msg === 'isdbgrid'
    }).catch(() => false)

    if (!available) {
      warn('MongoDB is not a replica set: a save is a sequence of writes rather than a transaction.')
    }
  }

  return available
}
