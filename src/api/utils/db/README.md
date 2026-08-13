This folder's index exports SAFE (non-throwing) functions that
are an abstraction over mongoDB to make interacting with
mongoDB safe and more ergonomic.

`findOne_` and `findMany_` take a filter document and an options
object — `{ projection, sort, limit }` — so a query can name more
than one field and can ask for only the fields the caller reads.
The `*ByField*` functions are sugar over them for the common case.
Anything the database can do, it should: a filter, a projection or
a limit applied in Node is documents fetched and sent for nothing.

Every document handed out is wrapped as `{ data, ref: { id } }` —
the shape callers across the API read — so a projection must keep
`_id`. `queries.js` enforces that, and holds the parts of a query
that can be tested without a database; `shapes.js` holds what the
results are turned into. Both are pure, both have tests.
