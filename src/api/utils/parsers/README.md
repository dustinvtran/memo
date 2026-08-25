This directory exports parsers which verify that data POSTed by
user matches the shape of our data structures. Other modules
should only be importing from this folder's index, everything
else should be considered private.

## An optional field is spelled `.optional()`

Not `.or(z.undefined())`, which is what every field here used to say and
what zod 3 accepted as the same thing. It is not the same thing in zod 4:
a key is allowed to be *absent* only when its schema is optional in zod's
own sense, and a union that merely happens to admit `undefined` is not.
`z.any()` and `z.unknown()` stopped implying it too.

The failure is quiet in the worst way. `.or(z.undefined())` still accepts
the key when it is present and set to `undefined`, so a schema written
that way looks like it works — it is the request that leaves the field out
altogether that starts coming back 400, which is most of them, since a
form only sends the fields someone filled in. See #182.
