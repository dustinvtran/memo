/** @typedef {import('mongodb').Db} Db */
/** @typedef {import('mongodb').ClientSession} ClientSession */
const { MongoClient, ServerApiVersion } = require('mongodb')
const { throwIt, warn } = require('../general')

const mongoClient = new MongoClient(process.env.MONGODB_URL ?? throwIt('MONGODB_URL not set'), {
  serverApi: ServerApiVersion.v1,
})

/** @type {Db | undefined} */
let mdb

/** @type {<T>(query: (db: Db) => Promise<T>) => Promise<T>} */
const mongo = async (query) => {
  if (mdb === undefined) {
    await mongoClient.connect()
    mdb = mongoClient.db('memo')
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
  return mongoClient.withSession((session) =>
    session.withTransaction(() => work(session))
  )
}

module.exports = {
  mongo,
  withTransaction,
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
