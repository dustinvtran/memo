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

const entries = {
  films: [
    {
      // An ordinary linked entry with nothing overridden. No hint should show
      // on any field, and no link panel at all.
      dbRef: "e-linked",
      userId: "u1",
      status: "Completed",
      score: 8,
      completedDate: Date.parse("2024-06-01"),
      workRef: dune._id,
      overrides: {},
      commonMetadata: dune,
    },
    {
      // A Planned film. Its completed-date container is hidden, which is why
      // this is the status that carried an invisible date until #370.
      dbRef: "e-planned",
      userId: "u1",
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
      dbRef: "e-unlinked",
      userId: "u1",
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
      dbRef: "e-season",
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

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const emptyTally = () =>
  Object.fromEntries([...Array(10)].map((_, i) => [String(i + 1), 0]).concat([["unrated", 0]]));

/**
 * The shapes each route has to return. Wrong here is worse than missing: the
 * three bugs in the header all shipped past a fixture that was confidently
 * the wrong shape.
 */
const api = (url, method, res) => {
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
  // bare `{}` renders Error404.
  //
  // It answers as the owner whatever the browser sends, with no `nf_jwt`
  // cookie and no `Authorization` header, which is deliberate — the edit
  // affordances are most of what there is to look at — and is the one place
  // the preview is unlike production, where no cookie means 401. So what a
  // logged-out reader sees is not what this route shows; the thing to watch
  // for #397 is whether the request is made at all.
  if (route === "name" && rest.length === 0) return send(res, 200, { username: USERNAME });
  if (route === "name") return send(res, 200, { data: { username: rest[0] } });

  // `/user/:name` is the profile page's first request and everything on that
  // page is inside it, so without this route the whole page was one error
  // line — the menu and the biography included, which is where #397's second
  // 401 came from. Only the public half of the document: `userId` and the
  // stats blob are deliberately not in the answer (#105), and a name nobody
  // has taken is a bare `{}`, which is what the page turns into Error404.
  if (route === "user") {
    return send(res, 200, rest[0] === USERNAME
      ? { data: { username: USERNAME, biography: "Fixtures, mostly.\n\n## A heading\n\nMarkdown, because the biography is rendered through `marked`." } }
      : {});
  }

  // A **raw array**, not an envelope.
  if (route === "entries" && method === "GET") return send(res, 200, entries[rest[0]] ?? []);

  if (route === "stats") {
    return send(res, 200, {
      scores: Object.fromEntries(Object.keys(entries).map((t) => [t, emptyTally()])),
      updatedDate: Date.now(),
    });
  }
  if (route === "reviews" && method === "GET") return send(res, 200, { data: { text: "" } });

  // `versions[].changes` must be an array, or `chipsHtml` throws on its length
  // and the history panel sits on its loader for ever.
  if (route === "revisions" && rest[2] === "draft") return send(res, 200, { draft: null });
  if (route === "revisions") return send(res, 200, { versions: [] });

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
        api(url, req.method, res);
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
