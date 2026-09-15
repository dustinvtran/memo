const { test } = require("node:test");
const assert = require("node:assert/strict");

const { COLLECTIONS } = require("./work_collections");
const {
  MIN_PAGE_COUNT,
  EDITION_FIELDS,
  toCandidate,
  candidateRejection,
  rankCandidates,
  proposeForWork,
  betterAttempt,
  refOwners,
  planRepoint,
} = require("./book_ref_proposal");

const books = COLLECTIONS.find((c) => c.type === "books");
const games = COLLECTIONS.find((c) => c.type === "games");

/**
 * Three of the books #344 names, as production holds them: an English title,
 * a French edition's ISBN, and whatever that edition's retrieve left behind.
 */
const littlePrince = {
  _id: "lp",
  entryType: "Book",
  englishTranslatedTitle: "The Little Prince",
  authors: ["Antoine de Saint-Exupéry"],
  apiRefs: ["ISBN__9782070408504"],
  releaseYear: 1943,
  duration: 96,
  imageUrl: "https://books.google.com/le_petit_prince.jpg",
  externalUrls: [
    { name: "Google Play", url: "https://books.google.com/books/about/Le_Petit_Prince.html?id=abc" },
  ],
  metadataUpdatedDate: 1750000000000,
};

const braveNewWorld = {
  _id: "bnw",
  entryType: "Book",
  englishTranslatedTitle: "Brave New World",
  authors: ["Aldous Huxley"],
  apiRefs: ["ISBN__9782266283038"],
  duration: 284,
};

const animalFarm = {
  _id: "af",
  entryType: "Book",
  englishTranslatedTitle: "Animal Farm",
  authors: ["George Orwell"],
  apiRefs: ["ISBN__9782070375165"],
};

/** A Google Books volumeInfo, with the fields a candidate reads. */
const volume = ({
  title,
  subtitle,
  isbn,
  publisher = "Houghton Mifflin Harcourt",
  pageCount = 100,
  language = "en",
  authors = ["Antoine de Saint-Exupéry"],
  publishedDate = "2000",
}) => ({
  title,
  subtitle,
  publisher,
  pageCount,
  language,
  authors,
  publishedDate,
  industryIdentifiers: isbn
    ? [
        { type: "ISBN_10", identifier: isbn.slice(3, 12) + "X" },
        { type: "ISBN_13", identifier: isbn },
      ]
    : [],
});

/** The sentence a rejection carries, or undefined when the volume is offered. */
const rejection = (work, volumeInfo, context) =>
  candidateRejection(work, toCandidate(volumeInfo), context)?.reason;

const stageOf = (work, volumeInfo, context) =>
  candidateRejection(work, toCandidate(volumeInfo), context)?.stage;

///////////////////////////////////////////////////////////////////////////////
// What a candidate is

test("reads the ISBN-13 and not whichever identifier Google lists first", () => {
  const candidate = toCandidate(
    volume({ title: "The Little Prince", isbn: "9780156012072" })
  );
  assert.equal(candidate.isbn, "9780156012072");
});

test("joins the subtitle the way a search result does", () => {
  const candidate = toCandidate(
    volume({
      title: "Sapiens",
      subtitle: "A Brief History of Humankind",
      isbn: "9780062316097",
    })
  );
  assert.equal(candidate.title, "Sapiens");
  assert.equal(candidate.fullTitle, "Sapiens: A Brief History of Humankind");
});

///////////////////////////////////////////////////////////////////////////////
// The filters, each against the volume from #344 that motivated it

test("accepts the edition a person picked by hand", () => {
  assert.equal(
    rejection(
      littlePrince,
      volume({ title: "The Little Prince", isbn: "9780156012072", pageCount: 100 })
    ),
    undefined
  );
});

test("refuses a volume with no ISBN-13 to file it under", () => {
  assert.match(
    rejection(littlePrince, volume({ title: "The Little Prince" })),
    /nothing to file it under/
  );
});

test("refuses another French edition", () => {
  assert.match(
    rejection(
      littlePrince,
      volume({ title: "The Little Prince", isbn: "9782070408504", language: "fr" })
    ),
    /language is fr/
  );
});

test("refuses the omnibus, which is the failure a title check exists for", () => {
  assert.match(
    rejection(
      braveNewWorld,
      volume({
        title: "Brave New World and Brave New World Revisited",
        isbn: "9780060776091",
        authors: ["Aldous Huxley"],
      })
    ),
    /not "Brave New World"/
  );
});

test("refuses the print-on-demand volume that leads the search", () => {
  assert.match(
    rejection(
      littlePrince,
      volume({
        title: "The Little Prince",
        isbn: "9786052259023",
        publisher: null,
        pageCount: 116,
      })
    ),
    /no publisher/
  );
});

test("refuses the one-page record", () => {
  assert.match(
    rejection(
      animalFarm,
      volume({
        title: "Animal Farm",
        isbn: "9789387390515",
        pageCount: 1,
        authors: ["George Orwell"],
      })
    ),
    /1 page\(s\), under the 10/
  );
});

test("a page count Google does not state is not a plausible one", () => {
  assert.match(
    rejection(
      animalFarm,
      volume({
        title: "Animal Farm",
        isbn: "9780451526342",
        pageCount: null,
        authors: ["George Orwell"],
      })
    ),
    /no page\(s\)/
  );
});

test("the shortest book in the library would still be offered", () => {
  assert.equal(
    rejection(
      animalFarm,
      volume({
        title: "Animal Farm",
        isbn: "9780451526342",
        pageCount: 11,
        authors: ["George Orwell"],
      })
    ),
    undefined
  );
  assert.equal(MIN_PAGE_COUNT, 10);
});

/**
 * The trap ../work_collections.js warns about, arriving through a search
 * rather than through a stored id: `comparableTitle` drops a trailing
 * parenthetical, so an Animorphs volume reduces to the same string as Camus'
 * novel and `titlesAgree` says yes.
 */
test("refuses somebody else's book of the same name", () => {
  const stranger = {
    _id: "camus",
    englishTranslatedTitle: "The Stranger",
    authors: ["Albert Camus"],
    apiRefs: ["ISBN__9782070360024"],
  };

  assert.match(
    rejection(
      stranger,
      volume({
        title: "The Stranger (Animorphs, #7)",
        isbn: "9780590997287",
        authors: ["K. A. Applegate"],
      })
    ),
    /K\. A\. Applegate.*Albert Camus/
  );
});

test("forgives an accent and a suffix on the author's name", () => {
  assert.equal(
    rejection(
      littlePrince,
      volume({
        title: "The Little Prince",
        isbn: "9780156012072",
        authors: ["Antoine de Saint Exupery (Author)"],
      })
    ),
    undefined
  );
});

test("a book with no stored author cannot be contradicted by one", () => {
  assert.equal(
    rejection(
      { ...animalFarm, authors: undefined },
      volume({
        title: "Animal Farm",
        isbn: "9780451526342",
        authors: ["Somebody Else"],
      })
    ),
    undefined
  );
});

///////////////////////////////////////////////////////////////////////////////
// Collisions

test("refuses a candidate another book is already filed under", () => {
  const owners = refOwners(books, [
    animalFarm,
    { _id: "other", apiRefs: ["ISBN__9780451526342"] },
  ]);

  assert.match(
    rejection(
      animalFarm,
      volume({
        title: "Animal Farm",
        isbn: "9780451526342",
        authors: ["George Orwell"],
      }),
      { owners }
    ),
    /other is filed under it/
  );
});

test("a book is not a collision with itself", () => {
  const already = { ...animalFarm, apiRefs: ["ISBN__9780451526342"] };
  const owners = refOwners(books, [already]);

  assert.equal(
    rejection(
      already,
      volume({
        title: "Animal Farm",
        isbn: "9780451526342",
        authors: ["George Orwell"],
      }),
      { owners }
    ),
    undefined
  );
});

test("refOwners reads both identity prefixes, not just ISBN__", () => {
  const owners = refOwners(books, [
    { _id: "a", apiRefs: ["google__9780451526342"] },
    { _id: "b", apiRefs: ["ISBN__N/A"] },
  ]);

  assert.deepEqual(owners.get("9780451526342"), ["a"]);
  assert.equal(owners.has("N/A"), false);
});

///////////////////////////////////////////////////////////////////////////////
// Ranking

test("a confirmed author outranks a plain title match", () => {
  const ranked = rankCandidates(animalFarm, [
    toCandidate(
      volume({ title: "Animal Farm", isbn: "9781111111111", authors: [] })
    ),
    toCandidate(
      volume({
        title: "Animal Farm",
        subtitle: "A Fairy Story",
        isbn: "9782222222222",
        authors: ["George Orwell"],
      })
    ),
  ]);

  assert.deepEqual(
    ranked.map((c) => c.isbn),
    ["9782222222222", "9781111111111"]
  );
});

test("the bare title outranks the one with a subtitle glued on", () => {
  const ranked = rankCandidates(animalFarm, [
    toCandidate(
      volume({
        title: "Animal Farm",
        subtitle: "With Study Guide",
        isbn: "9781111111111",
        authors: ["George Orwell"],
      })
    ),
    toCandidate(
      volume({
        title: "Animal Farm",
        isbn: "9782222222222",
        authors: ["George Orwell"],
      })
    ),
  ]);

  assert.deepEqual(
    ranked.map((c) => c.isbn),
    ["9782222222222", "9781111111111"]
  );
});

test("a page count near the stored one breaks a tie the others leave", () => {
  const ranked = rankCandidates(braveNewWorld, [
    toCandidate(
      volume({
        title: "Brave New World",
        isbn: "9781111111111",
        pageCount: 940,
        authors: ["Aldous Huxley"],
      })
    ),
    toCandidate(
      volume({
        title: "Brave New World",
        isbn: "9782222222222",
        pageCount: 288,
        authors: ["Aldous Huxley"],
      })
    ),
  ]);

  assert.deepEqual(
    ranked.map((c) => c.isbn),
    ["9782222222222", "9781111111111"]
  );
});

test("Google's own order breaks the ties nothing else does", () => {
  const ranked = rankCandidates({ ...animalFarm, authors: undefined }, [
    toCandidate(volume({ title: "Animal Farm", isbn: "9781111111111" })),
    toCandidate(volume({ title: "Animal Farm", isbn: "9782222222222" })),
  ]);

  assert.deepEqual(
    ranked.map((c) => c.isbn),
    ["9781111111111", "9782222222222"]
  );
});

///////////////////////////////////////////////////////////////////////////////
// One book's proposal

test("offers the survivors and records why the rest went", () => {
  const proposal = proposeForWork(
    littlePrince,
    { englishTranslatedTitle: "Le Petit Prince" },
    [
      volume({
        title: "The Little Prince",
        isbn: "9786052259023",
        publisher: null,
        pageCount: 116,
      }),
      volume({ title: "The Little Prince", isbn: "9780156012072", pageCount: 100 }),
    ]
  );

  assert.equal(proposal.currentRef, "9782070408504");
  assert.equal(proposal.currentRefNames, "Le Petit Prince");
  assert.deepEqual(
    proposal.candidates.map((c) => c.isbn),
    ["9780156012072"]
  );
  assert.equal(proposal.rejected.length, 1);
  assert.match(proposal.rejected[0].reason, /no publisher/);
  assert.equal(proposal.approved, null);
});

test("a book with nothing to offer is left empty rather than given the best of a bad set", () => {
  const proposal = proposeForWork(
    animalFarm,
    { englishTranslatedTitle: "La ferme des animaux" },
    [
      volume({
        title: "Animal Farm",
        isbn: "9788027341412",
        publisher: null,
        pageCount: 56,
        authors: ["George Orwell"],
      }),
      volume({
        title: "Animal Farm",
        isbn: "9789387390515",
        pageCount: 1,
        authors: ["George Orwell"],
      }),
    ]
  );

  assert.deepEqual(proposal.candidates, []);
  assert.equal(proposal.rejected.length, 2);
});

/**
 * The stage is how far a volume got, so it is what tells "this edition is not
 * in Google Books" from "it is, and one filter is in the way".
 */
test("a rejection says how far the volume got", () => {
  const stage = (v) => stageOf(animalFarm, v);
  const orwell = { authors: ["George Orwell"] };

  assert.ok(
    stage(volume({ title: "Animal Farm", ...orwell })) <
      stage(volume({ title: "Something Else", isbn: "9781111111111", ...orwell }))
  );
  assert.ok(
    stage(volume({ title: "Something Else", isbn: "9781111111111", ...orwell })) <
      stage(
        volume({
          title: "Animal Farm",
          isbn: "9781111111111",
          publisher: null,
          ...orwell,
        })
      )
  );
});

test("the nearest misses come first", () => {
  const proposal = proposeForWork(animalFarm, undefined, [
    volume({ title: "Animal Farm", authors: ["George Orwell"] }),
    volume({
      title: "Animal Farm",
      isbn: "9781111111111",
      pageCount: 1,
      authors: ["George Orwell"],
    }),
    volume({
      title: "A Different Book",
      isbn: "9782222222222",
      authors: ["George Orwell"],
    }),
  ]);

  assert.deepEqual(
    proposal.rejected.map((miss) => miss.label),
    ["too few pages", "another book", "no ISBN-13"]
  );
});

test("the same edition from both queries is offered once", () => {
  const one = volume({ title: "The Little Prince", isbn: "9780156012072" });
  const proposal = proposeForWork(littlePrince, undefined, [one, { ...one }]);

  assert.equal(proposal.candidates.length, 1);
  assert.equal(proposal.rejected.length, 0);
});

test("offers no more than asked for", () => {
  const proposal = proposeForWork(
    littlePrince,
    undefined,
    ["9781111111111", "9782222222222", "9783333333333"].map((isbn) =>
      volume({ title: "The Little Prince", isbn })
    ),
    { limit: 2 }
  );

  assert.equal(proposal.candidates.length, 2);
});

///////////////////////////////////////////////////////////////////////////////
// Retrying a rate-limited search

const attempt = (searchFailures, considered, candidates = 0) => ({
  searchFailures,
  considered,
  candidates: Array.from({ length: candidates }, (_, i) => ({ isbn: String(i) })),
});

test("a retry that was answered beats a first run that was not", () => {
  const previous = attempt(2, 0);
  const retried = attempt(0, 31, 3);
  assert.equal(betterAttempt(previous, retried), retried);
});

/**
 * The failure this guards: a retry throttled just as badly would otherwise
 * replace real candidates with an empty list, which is the unanswered question
 * destroying the answer.
 */
test("a retry that was throttled too keeps the earlier candidates", () => {
  const previous = attempt(1, 20, 2);
  const retried = attempt(2, 0);
  assert.equal(betterAttempt(previous, retried), previous);
});

test("on equal failures the attempt that saw more volumes wins", () => {
  const previous = attempt(1, 12, 1);
  const retried = attempt(1, 40, 0);
  assert.equal(betterAttempt(previous, retried), retried);
});

test("a clean retry that genuinely found nothing still replaces a clean first run", () => {
  const previous = attempt(0, 20, 0);
  const retried = attempt(0, 20, 0);
  assert.equal(betterAttempt(previous, retried), retried);
});

///////////////////////////////////////////////////////////////////////////////
// The write

const approval = (work, isbn, extra = {}) => ({
  id: String(work._id),
  title: work.englishTranslatedTitle,
  currentRef: work.apiRefs[0].split("__")[1],
  approved: isbn,
  ...extra,
});

const confirms = (isbn, title) =>
  new Map([[isbn, { fresh: { englishTranslatedTitle: title } }]]);

test("swaps the identity ref and leaves everything else in the array", () => {
  const work = {
    ...littlePrince,
    apiRefs: ["ISBN__9782070408504", "openlibrary__OL123M"],
  };

  const plan = planRepoint(
    books,
    [work],
    [approval(work, "9780156012072")],
    confirms("9780156012072", "The Little Prince")
  );

  assert.equal(plan.blocked, undefined);
  assert.equal(plan.repoints.length, 1);
  assert.deepEqual(plan.repoints[0].apiRefs, [
    "openlibrary__OL123M",
    "ISBN__9780156012072",
  ]);
  assert.deepEqual(plan.repoints[0].removedRefs, ["ISBN__9782070408504"]);
});

test("takes the same ISBN off under either prefix that names a book", () => {
  const work = {
    ...littlePrince,
    apiRefs: ["ISBN__9782070408504", "google__9782070408504"],
  };

  const plan = planRepoint(
    books,
    [work],
    [approval(work, "9780156012072")],
    confirms("9780156012072", "The Little Prince")
  );

  assert.deepEqual(plan.repoints[0].apiRefs, ["ISBN__9780156012072"]);
  assert.equal(plan.repoints[0].removedRefs.length, 2);
});

test("clears the edition's values and keeps the work's", () => {
  const plan = planRepoint(
    books,
    [littlePrince],
    [approval(littlePrince, "9780156012072")],
    confirms("9780156012072", "The Little Prince")
  );

  const [repoint] = plan.repoints;
  assert.deepEqual(
    repoint.unset.map((u) => u.field).sort(),
    ["duration", "imageUrl", "metadataUpdatedDate"]
  );
  assert.deepEqual(repoint.externalUrls, []);
  assert.equal(repoint.removedUrls.length, 1);
  // #333's measurement is the reason this one stays.
  assert.equal(Object.keys(EDITION_FIELDS).includes("releaseYear"), false);
});

test("does not report a field the book does not have as a value removed", () => {
  const plan = planRepoint(
    books,
    [animalFarm],
    [approval(animalFarm, "9780451526342")],
    confirms("9780451526342", "Animal Farm")
  );

  assert.deepEqual(plan.repoints[0].unset, []);
  assert.equal(plan.totals.values, 0);
});

test("skips an approval the API no longer confirms", () => {
  const plan = planRepoint(
    books,
    [braveNewWorld],
    [approval(braveNewWorld, "9780060776091")],
    confirms("9780060776091", "Brave New World and Brave New World Revisited")
  );

  assert.deepEqual(plan.repoints, []);
  assert.equal(plan.totals.approved, 1);
  assert.match(plan.skipped[0].reason, /Brave New World Revisited/);
});

test("skips an approval the API would not answer about", () => {
  const plan = planRepoint(
    books,
    [braveNewWorld],
    [approval(braveNewWorld, "9780060850524")],
    new Map([["9780060850524", { error: "503 from Google Books" }]])
  );

  assert.deepEqual(plan.repoints, []);
  assert.match(plan.skipped[0].reason, /503 from Google Books/);
});

test("skips a book that is already filed under what was approved for it", () => {
  const already = {
    ...animalFarm,
    apiRefs: ["ISBN__9780451526342"],
    duration: 112,
  };

  const plan = planRepoint(
    books,
    [already],
    [{ ...approval(already, "9780451526342") }],
    confirms("9780451526342", "Animal Farm")
  );

  assert.deepEqual(plan.repoints, []);
  assert.match(plan.skipped[0].reason, /already filed under it/);
});

test("skips an approval that would collide with a book written since", () => {
  const taken = { _id: "taken", apiRefs: ["ISBN__9780156012072"] };

  const plan = planRepoint(
    books,
    [littlePrince, taken],
    [approval(littlePrince, "9780156012072")],
    confirms("9780156012072", "The Little Prince")
  );

  assert.deepEqual(plan.repoints, []);
  assert.match(plan.skipped[0].reason, /taken is already filed under it/);
});

/**
 * Neither is in `refOwners` until one is written, so only counting the file
 * itself catches this.
 */
test("skips both halves of a collision the file would create between them", () => {
  const plan = planRepoint(
    books,
    [littlePrince, braveNewWorld],
    [
      approval(littlePrince, "9780156012072"),
      approval(braveNewWorld, "9780156012072"),
    ],
    confirms("9780156012072", "The Little Prince")
  );

  assert.deepEqual(plan.repoints, []);
  assert.equal(plan.skipped.length, 2);
  assert.match(plan.skipped[0].reason, /more than one book in this file/);
});

test("skips an ISBN somebody typed wrong", () => {
  const plan = planRepoint(
    books,
    [animalFarm],
    [approval(animalFarm, "0451526341")],
    new Map()
  );

  assert.match(plan.skipped[0].reason, /not an ISBN-13/);
});

test("skips a book that has been deleted since the proposal", () => {
  const plan = planRepoint(
    books,
    [],
    [approval(animalFarm, "9780451526342")],
    confirms("9780451526342", "Animal Farm")
  );

  assert.match(plan.skipped[0].reason, /not in books any more/);
});

test("writes nothing for a proposal nobody has looked at", () => {
  const plan = planRepoint(
    books,
    [littlePrince, animalFarm],
    [
      { ...approval(littlePrince, "9780156012072"), approved: null },
      { ...approval(animalFarm, "9780451526342"), approved: false },
    ],
    confirms("9780156012072", "The Little Prince")
  );

  assert.deepEqual(plan.repoints, []);
  assert.deepEqual(plan.skipped, []);
  assert.equal(plan.unapproved, 2);
  assert.equal(plan.totals.approved, 0);
});

test("refuses to plan for a collection that is not books", () => {
  const plan = planRepoint(games, [], [], new Map());
  assert.match(plan.blocked, /not books/);
});

test("refuses a proposal file that is not a list", () => {
  const plan = planRepoint(books, [], { proposals: [] }, new Map());
  assert.match(plan.blocked, /array of proposals/);
});
