#!/usr/bin/env node
/**
 * @file Serves a built `dist/` with the API answered from fixtures, so a
 * frontend change can be looked at without credentials and without production.
 *
 * `npx netlify dev` needs an interactive `netlify login` and points
 * `MONGODB_URL` at production Atlas, so it is not usable for a routine visual
 * check. This is the substitute: build with `npm run dev` (or
 * `npx cross-env ELEVENTY_ENV=dev eleventy`), then
 *
 *   node scripts/preview_with_fixtures.js 8099
 *
 * and open `http://localhost:8099/films/nil`. The url shape is type-first and
 * name-last — see `getEntryTypeFromUrl` in `js/utils/http.js` — and everything
 * that is not a real file is rewritten to `index.html`, because the site is a
 * client-routed SPA. See `_redirects`.
 *
 * **The fixtures are the point of this file, and getting one wrong is worse
 * than having none.** Three bugs shipped past a stub that invented shapes the
 * API does not return:
 *
 *   - `internalRef` on a list row. Only `/works/retrieve` and `/works/create`
 *     set that field; the list endpoint returns `commonMetadata: work`, the
 *     work document itself, whose id is `_id`. A stub that added it made the
 *     link panel in #370 look correct while it appeared on every row in
 *     production.
 *   - No entry that overrides a field of a real work, which is the only case
 *     where the override hint is supposed to render. #372 was invisible
 *     because every fixture legitimately had nothing to show.
 *   - No `Planned` film, which is the one status whose completed-date field is
 *     hidden and therefore the one that could carry a date nobody could see.
 *
 * So each fixture below says which case it is for. Add rows rather than
 * editing these, and keep them the shape the API really returns: the way to
 * check that is `src/api/controllers/entries.js`, not memory.
 *
 * A control route makes the API fail on demand, which is the only way to see
 * an error reach the UI:
 *
 *   fetch('/.netlify/functions/__stub?fail=' + encodeURIComponent('the message'))
 *
 * The next non-GET request answers 400 with that message and the flag clears.
 * It has to be the *next* one: the draft autosave in `draft.js` fires 2.5s
 * after a form opens, and it will eat a flag set before that.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist");
const PORT = Number(process.argv[2] ?? 8099);

/** Set by the control route; consumed by the next write. */
let failNextWrite = null;

/** The one user these fixtures belong to. `/name` answers as them. */
const USERNAME = "nil";

/**
 * A work as the API gives one: no `internalRef`, because the list endpoint
 * returns the document and only a retrieve adds that field.
 */
const theBear = {
  _id: "w-bear",
  entryType: "TVShow",
  apiRefs: ["tmdb__136315"],
  englishTranslatedTitle: "The Bear",
  originalTitle: "The Bear",
  releaseYear: 2022,
  duration: 30,
  episodes: 8,
  imageUrl: "",
  genres: ["Drama", "Comedy"],
  directors: [""],
  actors: ["Jeremy Allen White", "Ebon Moss-Bachrach"],
  externalUrls: [{ name: "tmdb", url: "https://www.themoviedb.org/tv/136315" }],
};

const dune = {
  _id: "w-dune",
  entryType: "Film",
  apiRefs: ["tmdb__693134"],
  englishTranslatedTitle: "Dune: Part Two",
  originalTitle: "Dune: Part Two",
  releaseYear: 2024,
  duration: 166,
  imageUrl: "",
  genres: ["Science Fiction", "Adventure"],
  directors: ["Denis Villeneuve"],
  actors: ["Timothée Chalamet"],
  externalUrls: [{ name: "tmdb", url: "https://www.themoviedb.org/movie/693134" }],
};

/**
 * A work with a real poster, stored the way every film and show written
 * before #483 stored one: on `www.themoviedb.org`, which redirects, at
 * 300×450. The list row should ask `image.tmdb.org` for `w92` of the same
 * file, and the comment panel should still show this url.
 */
const spaceOdyssey = {
  _id: "w-2001",
  entryType: "Film",
  apiRefs: ["tmdb__62"],
  englishTranslatedTitle: "2001: A Space Odyssey",
  originalTitle: "2001: A Space Odyssey",
  releaseYear: 1968,
  duration: 149,
  imageUrl: "https://www.themoviedb.org/t/p/w300_and_h450_bestv2/ve72VxNqjGM69Uky4WTo2bK6rfq.jpg",
  genres: ["Science Fiction", "Mystery", "Adventure"],
  directors: ["Stanley Kubrick"],
  actors: ["Keir Dullea", "Gary Lockwood"],
  externalUrls: [{ name: "tmdb", url: "https://www.themoviedb.org/movie/62" }],
};

/**
 * An entry's id is one of two shapes, and neither says when it was made: the
 * UUID `_create` mints, or the 18-digit id an entry from before the move to
 * Mongo kept from Fauna. So only an entry created since `addedDate` existed
 * carries one, and the Fauna-id row here has none, as 3,164 of production's
 * entries do not. #461.
 */
const LINKED = "0e4cb1bb-95c5-4f2e-9d7a-3b1c8e5a2f60";
const SEASON = "361538496209371213";

const entries = {
  films: [
    {
      // An ordinary linked entry with nothing overridden. No hint should show
      // on any field, and no link panel at all.
      dbRef: LINKED,
      userId: "u1",
      addedDate: Date.parse("2023-11-02T19:04:11Z"),
      status: "Completed",
      score: 8,
      completedDate: Date.parse("2024-06-01"),
      workRef: dune._id,
      overrides: {},
      commonMetadata: dune,
    },
    {
      // A film with a stored TMDB poster, for the list thumbnail (#483).
      dbRef: "7d2a9e41-3c6b-4f80-a15e-9b8c0d4e6f23",
      userId: "u1",
      addedDate: Date.parse("2023-03-12T21:47:05Z"),
      status: "Completed",
      score: 9,
      completedDate: Date.parse("2023-03-12"),
      workRef: spaceOdyssey._id,
      overrides: {},
      commonMetadata: spaceOdyssey,
    },
    {
      // A Planned film. Its completed-date container is hidden, which is why
      // this is the status that carried an invisible date until #370.
      dbRef: "f96cdd50-299b-4a8e-b1d2-6c0e7f3a9b14",
      userId: "u1",
      addedDate: Date.parse("2026-09-17T08:30:00Z"),
      status: "Planned",
      score: null,
      completedDate: null,
      workRef: dune._id,
      overrides: { englishTranslatedTitle: "Dune: Part Three" },
      commonMetadata: dune,
    },
    {
      // An entry with no work, written for something the databases did not
      // have yet. The link panel belongs on this one and on no other.
      dbRef: "ecac07aa-0f8f-4d61-8e3b-2a9c5d7e1f08",
      userId: "u1",
      addedDate: Date.parse("2026-01-12T20:15:00Z"),
      status: "Planned",
      score: null,
      completedDate: null,
      workRef: null,
      overrides: {
        englishTranslatedTitle: "The Odyssey",
        releaseYear: 2026,
        genres: ["Adventure"],
        directors: ["Christopher Nolan"],
      },
      // `list.js` folds the overrides over the work, and for an entry with no
      // work that leaves the overrides alone. `originalData` is undefined.
      commonMetadata: {
        englishTranslatedTitle: "The Odyssey",
        releaseYear: 2026,
        genres: ["Adventure"],
        directors: ["Christopher Nolan"],
      },
    },
  ],
  tv: [
    {
      // A season: the entry overrides a field of a real work, which is the
      // only shape that renders the override hint.
      dbRef: SEASON,
      userId: "u1",
      status: "Completed",
      score: 7,
      startedDate: Date.parse("2024-07-09"),
      completedDate: Date.parse("2024-07-14"),
      workRef: theBear._id,
      overrides: {
        englishTranslatedTitle: "The Bear: Season 2",
        originalTitle: "The Bear: Season 2",
        releaseYear: 2023,
      },
      commonMetadata: theBear,
    },
  ],
  games: [],
  books: [],
};

/** What a search answers with, and what retrieving one of them gives back. */
const WORKS = {
  tmdb__1241982: {
    _id: "w-odyssey",
    entryType: "Film",
    apiRefs: ["tmdb__1241982"],
    englishTranslatedTitle: "The Odyssey",
    originalTitle: "The Odyssey",
    releaseYear: 2026,
    duration: 180,
    imageUrl: "",
    genres: ["Adventure", "Drama", "Fantasy"],
    directors: ["Christopher Nolan"],
    actors: ["Matt Damon", "Tom Holland", "Zendaya"],
  },
  tmdb__136315: theBear,
  tmdb__693134: dune,
  // A book, so that a books search has a row in it as well as a count of what
  // it could not offer — the case #387 added. Filed under `ISBN__`, which is
  // what the Google Books adapter writes, and shaped like that adapter's
  // `retrieve`: authors and a page count where a film has actors and a
  // duration. See `src/api/utils/external_api_adapters/books/google.js`.
  ISBN__9780099448778: {
    _id: "w-sheep",
    entryType: "Book",
    apiRefs: ["ISBN__9780099448778"],
    englishTranslatedTitle: "A Wild Sheep Chase",
    originalTitle: "A Wild Sheep Chase",
    releaseYear: 2003,
    duration: 299,
    imageUrl: "",
    authors: ["Haruki Murakami"],
    publishers: ["Random House"],
    externalUrls: [],
  },
};

/**
 * An entry's history, built by the API's own `addedDateOf` and
 * `toVersionList` so its shape cannot drift from what
 * `GET /api/revisions/:type/:ref` answers. One case per way the timeline can
 * end today:
 *
 * - `LINKED` was added as Planned and edited twice since, so its oldest
 *   version *is* the entry as added, and opens to show all of it.
 * - `SEASON` has a Fauna id and no `addedDate`, so nothing says when it was
 *   added and the timeline ends on "What came before it is unknown".
 * - every other entry has never been edited, and its only version is both
 *   the current one and the one it was added with.
 *
 * The bare "Added" row, for an entry whose history begins after it was added,
 * has no case. An entry that knows its `addedDate` has had a history since
 * then, and reaches that row only when a save that changed nothing moved its
 * `updatedDate` on before the first real edit.
 */
const { addedDateOf, toVersionList } = require("../src/api/utils/revision_history.js");

const DAY = 24 * 60 * 60 * 1000;
const rowOf = (dbRef) => Object.values(entries).flat().find((row) => row.dbRef === dbRef);
const HISTORIES = {
  [LINKED]: () => {
    const added = addedDateOf(rowOf(LINKED));
    return {
      addedDate: added,
      versions: toVersionList(
        {
          id: "current",
          createdDate: Date.now() - 3 * DAY,
          snapshot: { status: "Completed", score: 8, completedDate: Date.parse("2024-06-01"), workRef: dune._id, review: "Better the second time.\nThe sound alone." },
        },
        [
          { id: "r1", createdDate: added, snapshot: { status: "Planned", score: 9, workRef: dune._id } },
          { id: "r2", createdDate: Date.parse("2024-06-01"), snapshot: { status: "Completed", score: 8, completedDate: Date.parse("2024-06-01"), workRef: dune._id, review: "Better the second time." } },
        ],
        added,
      ),
    };
  },
  [SEASON]: () => {
    const added = addedDateOf(rowOf(SEASON));
    return {
      addedDate: added,
      versions: toVersionList(
        { id: "current", createdDate: Date.now() - 30 * DAY, snapshot: { status: "Completed", score: 7 } },
        [{ id: "r1", createdDate: Date.now() - 60 * DAY, snapshot: { status: "InProgress", score: 7 } }],
        added,
      ),
    };
  },
};

const versionsOf = (dbRef) => {
  if (HISTORIES[dbRef]) return HISTORIES[dbRef]();
  const entry = rowOf(dbRef);
  const added = addedDateOf(entry);
  return {
    addedDate: added,
    versions: toVersionList(
      { id: "current", createdDate: added, snapshot: { status: entry?.status ?? "Planned", score: entry?.score, overrides: entry?.overrides } },
      [],
      added,
    ),
  };
};

/**
 * `GET /api/tokens` as `describe` in `src/api/controllers/tokens.js` answers
 * it: a **raw array**, no envelope, never a `tokenHash` and never a `token`.
 * `expiresAt` and `lastUsedAt` are `null` rather than absent when there is
 * nothing to say — `expiresAtOf` turns a missing field into `null`, so the
 * legacy row below is the same shape as a token made to last and the page
 * cannot tell them apart. One row per case #502 asks for. Kept in a `let` so
 * that a mint or a revoke from the page shows up in the next list, which the
 * page asks for straight after either.
 */
let apiTokens = [
  {
    // Never used: `lastUsedAt` is `null` until the first request with it.
    id: "3f1c2b7e-8a4d-4e6f-9b0a-1c2d3e4f5a61",
    name: "backup script",
    createdAt: Date.now() - 2 * DAY,
    expiresAt: Date.now() + 28 * DAY,
    lastUsedAt: null,
  },
  {
    // Used, and set never to expire.
    id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c62",
    name: "claude",
    createdAt: Date.now() - 40 * DAY,
    expiresAt: null,
    lastUsedAt: Date.now() - 3 * 3600 * 1000,
  },
  {
    // Expired: still listed until revoked, so its owner can see what stopped.
    id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b63",
    name: "one-off import",
    createdAt: Date.now() - 120 * DAY,
    expiresAt: Date.now() - 30 * DAY,
    lastUsedAt: Date.now() - 95 * DAY,
  },
  {
    // Legacy: minted before `expiresAt` existed, so the stored document has
    // no such field and the API answers `null` for it. The markup in the
    // name is there to be escaped — in the cell, the button's data attribute
    // and the confirm and notification text alike.
    id: "0b1a2c3d-4e5f-4061-8a7b-9c8d7e6f5a64",
    name: "<b>old</b> & forgotten",
    createdAt: Date.parse("2026-08-20T10:00:00Z"),
    expiresAt: null,
    lastUsedAt: Date.parse("2026-08-21T09:12:00Z"),
  },
];

/** `MAX_API_TOKENS_PER_USER` and the refusal `createApiToken` answers with. */
const MAX_API_TOKENS = 20;

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

/** What `responses.fromError` answers for `errors.notFound()`. */
const NOT_FOUND = { error: "NotFound", message: "not found" };

const emptyTally = () =>
  Object.fromEntries([...Array(10)].map((_, i) => [String(i + 1), 0]).concat([["unrated", 0]]));

/**
 * The shapes each route has to return. Wrong here is worse than missing: the
 * three bugs in the header all shipped past a fixture that was confidently
 * the wrong shape.
 */
const api = (url, method, res, body = "") => {
  const [, , route, ...rest] = url.pathname.split("/").filter(Boolean);

  if (route === "__stub") {
    failNextWrite = url.searchParams.get("fail");
    return send(res, 200, { failNextWrite });
  }
  // Ahead of the route table, because several routes below answer any method
  // and would otherwise make this unreachable for the one method it is for.
  if (method !== "GET" && failNextWrite) {
    const message = failNextWrite;
    failNextWrite = null;
    return send(res, 400, { error: "RequestError", message });
  }

  // `/name` is the signed-in user; 401 here is what makes `isOwner` false and
  // hides the edit buttons. `/name/:name` wraps its answer in `data`, and a
  // name nobody has taken is a 404, which the list page draws as Error404 —
  // a bare `{}` until #477.
  //
  // It answers as the owner whatever the browser sends, with no `nf_jwt`
  // cookie and no `Authorization` header, which is deliberate — the edit
  // affordances are most of what there is to look at — and is the one place
  // the preview is unlike production, where no cookie means 401. So what a
  // logged-out reader sees is not what this route shows; the thing to watch
  // for #397 is whether the request is made at all.
  if (route === "name" && rest.length === 0) return send(res, 200, { username: USERNAME });
  if (route === "name") {
    return rest[0] === USERNAME
      ? send(res, 200, { data: { username: USERNAME } })
      : send(res, 404, NOT_FOUND);
  }

  // `/user/:name` is the profile page's first request and everything on that
  // page is inside it, so without this route the whole page was one error
  // line — the menu and the biography included, which is where #397's second
  // 401 came from. Only the public half of the document: `userId` and the
  // stats blob are deliberately not in the answer (#105), and a name nobody
  // has taken is a 404, which is what the page turns into Error404 (#477).
  if (route === "user") {
    return rest[0] === USERNAME
      ? send(res, 200, { data: { username: USERNAME, biography: "Fixtures, mostly.\n\n## A heading\n\nMarkdown, because the biography is rendered through `marked`." } })
      : send(res, 404, NOT_FOUND);
  }

  // A **raw array**, not an envelope.
  if (route === "entries" && method === "GET") return send(res, 200, entries[rest[0]] ?? []);

  if (route === "stats") {
    return send(res, 200, {
      scores: Object.fromEntries(Object.keys(entries).map((t) => [t, emptyTally()])),
      updatedDate: Date.now(),
    });
  }
  // A dbRef no fixture has is a 404, as the real route answers since #477.
  // The real one also 400s an id with punctuation in it, which no fixture can
  // produce; `reviews.test.js` has that half.
  if (route === "reviews" && method === "GET") {
    return Object.values(entries).flat().some((row) => row.dbRef === rest[1])
      ? send(res, 200, { data: { text: "" } })
      : send(res, 404, NOT_FOUND);
  }

  // `versions[].changes` must be an array, or `chipsHtml` throws on its length
  // and the history panel sits on its loader for ever.
  if (route === "revisions" && rest[2] === "draft") return send(res, 200, { draft: null });
  if (route === "revisions") return send(res, 200, versionsOf(rest[1]));

  // A search answers with `{ results }` and **not** a bare array, and a books
  // search carries `discarded` beside it: the count of volumes Google lists no
  // ISBN for, which cannot be offered because a book is filed under its ISBN.
  // #387. Only books has one — the other three adapters offer everything they
  // find — and it is the one number the results list draws a line for, so a
  // stub sending an array here would hide both that line and the list itself.
  if (route === "works" && rest[0] === "search") {
    const type = rest[1];
    const query = decodeURIComponent(rest.slice(2).join("/")).toLowerCase();
    const results = Object.entries(WORKS)
      .filter(([, w]) => w.englishTranslatedTitle.toLowerCase().includes(query))
      .map(([ref, w]) => ({
        ref: ref.split("__")[1],
        title: w.englishTranslatedTitle,
        year: w.releaseYear,
        imageUrl: w.imageUrl,
      }));

    return send(res, 200, {
      results,
      // Searching books for something these fixtures do not hold is the other
      // case worth seeing: every candidate discarded, which is a different
      // answer from "no results found for this query".
      ...(type === "books" ? { discarded: { noRef: 2, duplicateRef: 1 } } : {}),
    });
  }
  if (route === "works" && rest[0] === "retrieve") {
    // Books are filed under `ISBN__` and everything else under `tmdb__`, and
    // the url carries the bare id either way.
    const work = WORKS[`tmdb__${rest[2]}`] ?? WORKS[`ISBN__${rest[2]}`];
    // `internalRef` is added **here and only here**, which is the asymmetry
    // that hid the #370 bug.
    return work
      ? send(res, 200, { ...work, internalRef: work._id })
      : send(res, 404, { message: `no work for ${rest[2]}` });
  }

  // The three token routes. A mint answers the listed fields and `token`
  // beside them, once; a revoke answers the listed fields of what it removed;
  // an id that is not one of these is a 404, as someone else's is for real.
  // A name that will not parse is the 400 `validate` gives every bad body.
  if (route === "tokens") {
    if (method === "GET" && rest.length === 0) return send(res, 200, apiTokens);
    if (method === "POST" && rest.length === 0) {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch (e) { parsed = {}; }
      const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
      const lifetime = parsed.expiresInSeconds ?? null;
      if (!name || name.length > 64 || (lifetime !== null && !(Number.isInteger(lifetime) && lifetime > 0))) {
        return send(res, 400, { error: "RequestError", message: "the request body is not valid" });
      }
      const now = Date.now();
      if (apiTokens.filter((t) => t.expiresAt === null || now < t.expiresAt).length >= MAX_API_TOKENS) {
        return send(res, 409, { error: "Conflict", message: `there are already ${MAX_API_TOKENS} API tokens; revoke one first` });
      }
      const created = {
        id: require("node:crypto").randomUUID(),
        name,
        createdAt: now,
        expiresAt: lifetime === null ? null : now + lifetime * 1000,
        lastUsedAt: null,
      };
      apiTokens = [...apiTokens, created];
      // Shaped like `generateApiToken`'s output and minted per request, so no
      // token-shaped string is ever written into this file for a secret
      // scanner to find.
      const token = "memo_pat_" + require("node:crypto").randomBytes(32).toString("base64url");
      return send(res, 200, { ...created, token });
    }
    if (method === "DELETE" && rest.length === 1) {
      const found = apiTokens.find((t) => t.id === rest[0]);
      if (!found) return send(res, 404, NOT_FOUND);
      apiTokens = apiTokens.filter((t) => t !== found);
      return send(res, 200, found);
    }
    return send(res, 404, NOT_FOUND);
  }

  // Writes are accepted and discarded. Saving ends in `location.reload()`, so
  // a change made in the form does not survive; to see one persist, keep it
  // in `entries` above.
  if (method !== "GET") return send(res, 200, { ok: true });
  return send(res, 404, { message: `the stub has no ${route}` });
};

const TYPES = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".xml": "application/xml",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith("/.netlify/functions/")) {
      if (req.method === "GET") return api(url, req.method, res);
      // Drained before answering, so a route that wants the body can have it.
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      return req.on("end", () => {
        if (process.env.STUB_LOG) console.log(`${req.method} ${url.pathname}\n${body}`);
        api(url, req.method, res, body);
      });
    }

    const file = path.join(DIST, url.pathname);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "text/plain" });
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(fs.readFileSync(path.join(DIST, "index.html")));
  })
  .listen(PORT, () => {
    if (!fs.existsSync(path.join(DIST, "index.html"))) {
      console.error(`No dist/index.html — build first: npx cross-env ELEVENTY_ENV=dev eleventy`);
    }
    console.log(`http://localhost:${PORT}/films/${USERNAME}    (tv, games, books too)`);
  });
