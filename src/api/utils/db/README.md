This folder's index exports SAFE (non-throwing) functions that
are an abstraction over mongoDB to make interacting with
mongoDB safe and more ergonomic.

`findOne_` and `findMany_` take a filter document and an options
object — `{ projection, sort, limit }` — so a query can name more
than one field and can ask for only the fields the caller reads.
The `*ByField*` functions are sugar over them for the common case.
Anything the database can do, it should: a filter, a projection or
a limit applied in Node is documents fetched and sent for nothing.

`withTransaction` runs a group of writes so that either all of them
land or none do — saving an entry and its long note is the one that
needs it. A write takes the session it hands out as an optional last
argument and a read takes it in its options; a query given neither
runs outside the transaction, and cannot see what it has written.
Transactions need a replica set, which Atlas is; against a standalone
`mongod` the writes run in order without one. See db.js.

Every document handed out is wrapped as `{ data, ref: { id } }` —
the shape callers across the API read — so a projection must keep
`_id`. `queries.js` enforces that, and holds the parts of a query
that can be tested without a database; `shapes.js` holds what the
results are turned into. Both are pure, both have tests.
