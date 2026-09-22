const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  BUCKETS,
  REPAIRS,
  parseRefusal,
  titleRelation,
  isSubtitleTrap,
  authorAgreement,
  editionMarker,
  isNonEnglish,
  classifyRefusal,
  triageRow,
  summarize,
} = require("./book_refusal_triage");

/**
 * The books are the ones #385 names, with the titles and authors production
 * holds. Using the issue's own examples is the point: each bucket is defined
 * by a row somebody looked at, so a test that passes on invented data would
 * not tell us the classifier agrees with the person who filed the issue.
 */

test("parseRefusal reads back the message titleConflict builds", () => {
  // Copied from work_metadata_merge.js's titleConflict, em dash and all.
  const message =
    'refused: stored title "Howl and Other Poems" but the apiRef names ' +
    '"Howl" — one of them is filed under the other\'s id';

  assert.deepEqual(parseRefusal(message), {
    storedTitle: "Howl and Other Poems",
    refTitle: "Howl",
  });
});

test("parseRefusal is not fooled by a title containing the phrase", () => {
  const message =
    'refused: stored title "but the apiRef names \\"x\\"" but the apiRef ' +
    'names "Real Title" — one of them is filed under the other\'s id';

  // Non-greedy from the left would stop early; the right answer keeps the
  // whole stored title and still finds the real second one.
  const parsed = parseRefusal(message);
  assert.equal(parsed.refTitle, "Real Title");
});

test("parseRefusal returns undefined for anything else", () => {
  assert.equal(parseRefusal("some other guard said no"), undefined);
  assert.equal(parseRefusal(undefined), undefined);
  assert.equal(parseRefusal(null), undefined);
});

test("titleRelation finds the containment titlesAgree deliberately refuses", () => {
  assert.equal(titleRelation("Howl and Other Poems", "Howl"), "stored-contains-ref");
  assert.equal(
    titleRelation("Numerical Analysis", "INTRODUCTORY METHODS OF NUMERICAL ANALYSIS, FIFTH EDITION"),
    "ref-contains-stored"
  );
  assert.equal(titleRelation("Foundation", "Fondation"), "disjoint");
  assert.equal(titleRelation("Howl", "Howl"), "equal");
});

test("titleRelation says unknown rather than guessing at an empty side", () => {
  assert.equal(titleRelation("", "Howl"), "unknown");
  assert.equal(titleRelation("Howl", undefined), "unknown");
});

test("titleRelation reduces the way comparableTitle does", () => {
  // Trailing parentheticals go, so the series marker is not a difference.
  assert.equal(titleRelation("Foundation (Foundation, #1)", "Foundation"), "equal");
});

test("isSubtitleTrap fires on the joined title and not on the bare one", () => {
  const evidence = {
    storedTitle: "The Idea Factory: Bell Labs and the Great Age of American Innovation",
    refTitle: "The Idea Factory",
    refSubtitle: "Bell Labs and the Great Age of American Innovation",
  };
  assert.equal(isSubtitleTrap(evidence), true);
});

test("isSubtitleTrap needs a subtitle and never infers one from a colon", () => {
  // A stored title with a colon whose volume has no subtitle is a normal
  // disagreement, not the adapter's asymmetry.
  assert.equal(
    isSubtitleTrap({
      storedTitle: "Another: Volume 2",
      refTitle: "Another - La Fille à l'oeil de poupée",
    }),
    false
  );
});

test("isSubtitleTrap does not fire when the bare title already matches", () => {
  // Nothing was refused here, so there is no trap to report.
  assert.equal(
    isSubtitleTrap({
      storedTitle: "The Idea Factory",
      refTitle: "The Idea Factory",
      refSubtitle: "Bell Labs",
    }),
    false
  );
});

test("authorAgreement treats one shared name as agreement", () => {
  assert.equal(
    authorAgreement(["Isaac Asimov"], ["Isaac Asimov", "Jacques Brécard"]),
    "shared"
  );
});

test("authorAgreement ignores marks and punctuation", () => {
  assert.equal(
    authorAgreement(["Antoine de Saint-Exupéry"], ["Antoine de Saint Exupery"]),
    "shared"
  );
});

test("authorAgreement says unknown, never conflict, when a side is silent", () => {
  assert.equal(authorAgreement([], ["Someone"]), "unknown");
  assert.equal(authorAgreement(["Someone"], undefined), "unknown");
  assert.equal(authorAgreement([""], ["Someone"]), "unknown");
});

test("authorAgreement reports a real conflict", () => {
  assert.equal(authorAgreement(["村上春樹"], ["Matthew Carl Strecher"]), "conflict");
});

test("isNonEnglish distinguishes absent from English", () => {
  assert.equal(isNonEnglish("fr"), true);
  assert.equal(isNonEnglish("ja"), true);
  assert.equal(isNonEnglish("en"), false);
  assert.equal(isNonEnglish("en-GB"), false);
  assert.equal(isNonEnglish(undefined), undefined);
  assert.equal(isNonEnglish(""), undefined);
});

test("editionMarker finds a printing word and is case-insensitive", () => {
  assert.equal(
    editionMarker("INTRODUCTORY METHODS OF NUMERICAL ANALYSIS, FIFTH EDITION"),
    "edition"
  );
  assert.equal(editionMarker("Dressing the Man"), undefined);
});

// --- the four buckets, on the issue's own rows -----------------------------

test("bucket 1: a different edition of the right book", () => {
  const { bucket, evidence } = classifyRefusal({
    storedTitle: "Numerical Analysis",
    refTitle: "INTRODUCTORY METHODS OF NUMERICAL ANALYSIS, FIFTH EDITION",
    storedAuthors: ["S.S. Sastry"],
    refAuthors: ["S. S. SASTRY"],
    refLanguage: "en",
  });
  assert.equal(bucket, BUCKETS.EDITION);
  assert.equal(evidence.titleRelation, "ref-contains-stored");
  assert.equal(evidence.editionMarker, "edition");
});

test("bucket 2: a translation, which is a shared author in another language", () => {
  const { bucket, reasoning } = classifyRefusal({
    storedTitle: "Foundation (Foundation, #1)",
    refTitle: "Fondation",
    storedAuthors: ["Isaac Asimov"],
    refAuthors: ["Isaac Asimov"],
    refLanguage: "fr",
  });
  assert.equal(bucket, BUCKETS.TRANSLATION);
  assert.match(reasoning, /fresh English ISBN/);
});

test("bucket 2: Franny and Zooey under Franny et Zoé", () => {
  assert.equal(
    classifyRefusal({
      storedTitle: "Franny and Zooey",
      refTitle: "Franny et Zoé",
      storedAuthors: ["J.D. Salinger"],
      refAuthors: ["Jerome David Salinger"],
      refLanguage: "fr",
    }).bucket,
    // "J.D. Salinger" and "Jerome David Salinger" share no whole name, only a
    // surname. Without the fallback this reads as a conflict and a plain
    // translation is proposed for a repoint — the one destructive repair.
    BUCKETS.TRANSLATION
  );
});

test("authorAgreement matches an abbreviated name against a spelled-out one", () => {
  assert.equal(
    authorAgreement(["J.D. Salinger"], ["Jerome David Salinger"]),
    "shared"
  );
  assert.equal(authorAgreement(["S.S. Sastry"], ["S. S. SASTRY"]), "shared");
});

test("authorAgreement does not call a shared initial a shared author", () => {
  // Surnames under three characters are not evidence of anything.
  assert.equal(authorAgreement(["Ann B."], ["Carl B."]), "conflict");
});

test("authorAgreement still separates two different people", () => {
  assert.equal(
    authorAgreement(["Haruki Murakami"], ["Matthew Carl Strecher"]),
    "conflict"
  );
  // A shared forename is not a shared surname.
  assert.equal(authorAgreement(["Alan Flusser"], ["Alan Moore"]), "conflict");
});

test("bucket 3: a different book entirely, caught by the author", () => {
  const { bucket } = classifyRefusal({
    storedTitle: "ノルウェイの森 (Noruwei no Mori)",
    refTitle: "Haruki Murakami and His Early Work",
    storedAuthors: ["村上春樹"],
    refAuthors: ["Matthew Carl Strecher"],
    refLanguage: "en",
  });
  assert.equal(bucket, BUCKETS.DIFFERENT_BOOK);
});

test("bucket 3 beats a same-script reading: Kokoro under 会津のこころ", () => {
  // Both titles are Japanese, so anything keying on script would call this a
  // translation of itself. The authors are what say otherwise.
  const { bucket } = classifyRefusal({
    storedTitle: "こゝろ (Kokoro)",
    refTitle: "会津のこころ",
    storedAuthors: ["夏目漱石"],
    refAuthors: ["会津新篇百景刊行会"],
    refLanguage: "ja",
  });
  assert.equal(bucket, BUCKETS.DIFFERENT_BOOK);
});

test("bucket 4: a shorter or longer title for the same thing", () => {
  const { bucket } = classifyRefusal({
    storedTitle: "Howl and Other Poems",
    refTitle: "Howl",
    storedAuthors: ["Allen Ginsberg"],
    refAuthors: ["Allen Ginsberg"],
    refLanguage: "en",
  });
  assert.equal(bucket, BUCKETS.TITLE_LENGTH);
});

test("the subtitle trap is its own answer and carries no repair", () => {
  const { bucket, reasoning } = classifyRefusal({
    storedTitle: "The Idea Factory: Bell Labs and the Great Age of American Innovation",
    refTitle: "The Idea Factory",
    refSubtitle: "Bell Labs and the Great Age of American Innovation",
    storedAuthors: ["Jon Gertner"],
    refAuthors: ["Jon Gertner"],
    refLanguage: "en",
  });
  assert.equal(bucket, BUCKETS.SUBTITLE_TRAP);
  assert.equal(REPAIRS[bucket], null);
  assert.match(reasoning, /No data repair/);
});

test("the subtitle trap is read before the author and the titles", () => {
  // Containment holds here too; the trap has to win or this lands in bucket 4
  // and somebody renames a work to work around a code bug.
  const { bucket } = classifyRefusal({
    storedTitle: "The Idea Factory: Bell Labs",
    refTitle: "The Idea Factory",
    refSubtitle: "Bell Labs",
    storedAuthors: ["Jon Gertner"],
    refAuthors: [],
  });
  assert.equal(bucket, BUCKETS.SUBTITLE_TRAP);
});

// --- where it refuses to guess --------------------------------------------

test("same author, unrelated titles, is needs-human and says both readings", () => {
  const { bucket, reasoning } = classifyRefusal({
    storedTitle: "The Fundamentals of Style - How to be a Well-Dressed Man",
    refTitle: "Dressing the Man",
    storedAuthors: ["Alan Flusser"],
    refAuthors: ["Alan Flusser"],
    refLanguage: "en",
  });
  assert.equal(bucket, BUCKETS.NEEDS_HUMAN);
  assert.match(reasoning, /different book by the same author/);
});

test("no author on either side and nothing in common is needs-human", () => {
  const { bucket, reasoning } = classifyRefusal({
    storedTitle: "Jailbreak",
    refTitle: "The Jehovahs' Jailbreak",
    storedAuthors: [],
    refAuthors: [],
  });
  // Containment does hold on this pair, so it is bucket 4 by the titles; the
  // point of the row below is the genuinely disjoint case.
  assert.equal(bucket, BUCKETS.TITLE_LENGTH);
  assert.match(reasoning, /do not disagree/);

  const disjoint = classifyRefusal({
    storedTitle: "Bard Quest",
    refTitle: "The Brimming Bards",
    storedAuthors: [],
    refAuthors: [],
  });
  assert.equal(disjoint.bucket, BUCKETS.NEEDS_HUMAN);
  assert.match(disjoint.reasoning, /not established/);
});

test("a non-English answer with no author is not called a translation", () => {
  const { bucket, reasoning } = classifyRefusal({
    storedTitle: "Another: Volume 2",
    refTitle: "Another - La Fille à l'oeil de poupée",
    storedAuthors: [],
    refAuthors: [],
    refLanguage: "fr",
  });
  assert.equal(bucket, BUCKETS.NEEDS_HUMAN);
  assert.match(reasoning, /cannot be told from a different book/);
});

test("an absent ISBN title is an absent answer, not a finding", () => {
  const { bucket, reasoning } = classifyRefusal({
    storedTitle: "Howl and Other Poems",
    refTitle: undefined,
  });
  assert.equal(bucket, BUCKETS.NEEDS_HUMAN);
  assert.match(reasoning, /nothing was compared/i);
});

test("titles that now agree are reported as stale, not repaired", () => {
  const { bucket, reasoning } = classifyRefusal({
    storedTitle: "Howl",
    refTitle: "The Howl",
    storedAuthors: ["Allen Ginsberg"],
    refAuthors: ["Allen Ginsberg"],
  });
  assert.equal(bucket, BUCKETS.NEEDS_HUMAN);
  assert.match(reasoning, /stale/);
});

// --- the row a repair script reads back ------------------------------------

const howl = {
  _id: "howl1",
  entryType: "Book",
  englishTranslatedTitle: "Howl and Other Poems",
  authors: ["Allen Ginsberg"],
  apiRefs: ["ISBN__9780872860179"],
};

test("a rename row is a link_entry retitle with the entryTitle left blank", () => {
  const row = triageRow({
    work: howl,
    refTitle: "Howl",
    refAuthors: ["Allen Ginsberg"],
    refLanguage: "en",
    isbn: "9780872860179",
  });

  assert.equal(row.bucket, BUCKETS.TITLE_LENGTH);
  assert.equal(row.id, "howl1");
  assert.equal(row.storedTitle, "Howl and Other Poems");
  assert.equal(row.refTitle, "Howl");
  assert.equal(row.approved, null);
  assert.deepEqual({ ...row.apply }, {
    script: "link_entry.js",
    op: "retitle",
    type: "books",
    toWork: "howl1",
    workTitle: "Howl",
    entryTitle: "",
    entry: "",
  });
});

test("a repoint row names the ref it replaces and leaves the new one blank", () => {
  const row = triageRow({
    work: {
      _id: "nw1",
      englishTranslatedTitle: "ノルウェイの森 (Noruwei no Mori)",
      authors: ["村上春樹"],
    },
    refTitle: "Haruki Murakami and His Early Work",
    refAuthors: ["Matthew Carl Strecher"],
    refLanguage: "en",
    isbn: "9780824822262",
    apiRef: "ISBN__9780824822262",
  });

  assert.equal(row.bucket, BUCKETS.DIFFERENT_BOOK);
  assert.deepEqual({ ...row.apply }, {
    script: "set_work_ref.js",
    work: "nw1",
    ref: "",
    replacesRef: "ISBN__9780824822262",
  });
});

test("replacesRef is the stored ref and is never rebuilt from the number", () => {
  // set_work_ref.js compares replacesRef against the ref the document carries.
  // Given only the bare number there is nothing to compare, so the field is
  // left empty for a person rather than spelled with a guessed prefix — a
  // wrong one refuses silently, and books are the only type where the two
  // forms differ.
  const row = triageRow({
    work: { _id: "x1", englishTranslatedTitle: "A", authors: ["One"] },
    refTitle: "B",
    refAuthors: ["Two"],
    isbn: "9780000000000",
  });

  assert.equal(row.bucket, BUCKETS.DIFFERENT_BOOK);
  assert.equal(row.apply.replacesRef, "");
  assert.equal(row.apiRef, null);
});

test("a translation row asks propose_book_refs for candidates, not an ISBN", () => {
  const row = triageRow({
    work: { _id: "f1", englishTranslatedTitle: "Foundation", authors: ["Isaac Asimov"] },
    refTitle: "Fondation",
    refAuthors: ["Isaac Asimov"],
    refLanguage: "fr",
    isbn: "9782070360536",
  });

  assert.equal(row.bucket, BUCKETS.TRANSLATION);
  assert.deepEqual({ ...row.apply }, {
    script: "propose_book_refs.js",
    work: "f1",
    searchTitle: "Foundation",
  });
});

test("the two no-repair buckets carry no operation at all", () => {
  const trap = triageRow({
    work: { _id: "i1", englishTranslatedTitle: "The Idea Factory: Bell Labs" },
    refTitle: "The Idea Factory",
    refSubtitle: "Bell Labs",
  });
  assert.equal(trap.bucket, BUCKETS.SUBTITLE_TRAP);
  assert.equal(trap.apply, null);
  assert.equal(trap.repair, null);

  const unsure = triageRow({
    work: { _id: "d1", englishTranslatedTitle: "Bard Quest" },
    refTitle: "The Brimming Bards",
  });
  assert.equal(unsure.bucket, BUCKETS.NEEDS_HUMAN);
  assert.equal(unsure.apply, null);
});

test("every row carries the evidence its call was made on", () => {
  const row = triageRow({
    work: howl,
    refTitle: "Howl",
    refAuthors: ["Allen Ginsberg"],
    refLanguage: "en",
  });
  assert.deepEqual({ ...Object.keys(row.evidence) }, {
    ...["titleRelation", "authors", "refLanguage", "editionMarker", "subtitleTrap"],
  });
  assert.equal(row.evidence.authors, "shared");
  assert.equal(row.reasoning.length > 0, true);
});

// --- counting --------------------------------------------------------------

test("summarize counts every bucket, including the empty ones", () => {
  const rows = [
    { bucket: BUCKETS.EDITION },
    { bucket: BUCKETS.EDITION },
    { bucket: BUCKETS.DIFFERENT_BOOK },
  ];
  const totals = summarize(rows);

  assert.equal(totals.classified, 3);
  assert.equal(totals.buckets[BUCKETS.EDITION], 2);
  assert.equal(totals.buckets[BUCKETS.DIFFERENT_BOOK], 1);
  // Present and zero rather than absent, so a reader sees the bucket was
  // considered and came out empty.
  assert.equal(totals.buckets[BUCKETS.TRANSLATION], 0);
  assert.equal(totals.buckets[BUCKETS.NEEDS_HUMAN], 0);
});

test("summarize keeps unanswered questions out of the findings", () => {
  // #385 is explicit that the 54 failures are quota and not frozen works, and
  // that a search that could not run is a third answer. Neither may be added
  // into a bucket.
  const totals = summarize([{ bucket: BUCKETS.EDITION }], {
    notSearched: 7,
    failures: 54,
  });

  assert.equal(totals.classified, 1);
  assert.equal(totals.notSearched, 7);
  assert.equal(totals.failures, 54);
  assert.equal(
    Object.values(totals.buckets).reduce((a, b) => a + b, 0),
    1
  );
});

test("summarize survives junk", () => {
  assert.equal(summarize(undefined).classified, 0);
  assert.equal(summarize([{ bucket: "not-a-bucket" }]).classified, 1);
  assert.equal(
    Object.values(summarize([{ bucket: "not-a-bucket" }]).buckets).reduce((a, b) => a + b, 0),
    0
  );
});

// --- the readable copy, which is what a person approves from ---------------

const { toMarkdown, describeSummary, BUCKET_TITLES } = require("./book_refusal_triage");

/** One of each interesting shape, as a run would have produced them. */
const sampleFile = () => {
  const rows = [
    triageRow({
      work: howl,
      refTitle: "Howl",
      refAuthors: ["Allen Ginsberg"],
      refLanguage: "en",
      isbn: "9780872860179",
      apiRef: "ISBN__9780872860179",
    }),
    triageRow({
      work: {
        _id: "nw1",
        englishTranslatedTitle: "ノルウェイの森 (Noruwei no Mori)",
        authors: ["村上春樹"],
      },
      refTitle: "Haruki Murakami and His Early Work",
      refAuthors: ["Matthew Carl Strecher"],
      refLanguage: "en",
      isbn: "9780824822262",
      apiRef: "ISBN__9780824822262",
    }),
  ];
  const notSearched = [
    {
      id: "q1",
      storedTitle: "A Book Nobody Asked About",
      apiRef: "ISBN__9780000000000",
      notSearchedBecause: "429 Too Many Requests",
    },
  ];
  return {
    generatedAt: "2026-09-22T00:00:00.000Z",
    summary: summarize(rows, { notSearched: notSearched.length, failures: 54 }),
    rows,
    notSearched,
  };
};

test("the readable copy says plainly that nothing has been applied", () => {
  const md = toMarkdown(sampleFile(), "triage.json");
  assert.match(md, /No repair has been applied/);
  assert.match(md, /entryTitle` you type yourself/);
});

test("the readable copy keeps unanswered lookups out of the buckets", () => {
  const md = toMarkdown(sampleFile(), "triage.json");

  // Its own section, named as not a finding, and the book is not under a
  // bucket heading.
  assert.match(md, /## Not searched — no answer, and so no finding/);
  assert.match(md, /A Book Nobody Asked About/);
  assert.match(md, /\| _not searched — no answer, not a finding_ \| 1 \|/);
  assert.match(md, /\| _backfill failures — quota, not refusals_ \| 54 \|/);
});

test("the readable copy prints every bucket's count and only the used headings", () => {
  const md = toMarkdown(sampleFile(), "triage.json");

  // Counted, including the zeroes.
  assert.match(md, /\| translation \| 0 \|/);
  // But a heading only where there are rows to put under it.
  assert.equal(md.includes(BUCKET_TITLES[BUCKETS.TRANSLATION]), false);
  assert.match(md, new RegExp(BUCKET_TITLES[BUCKETS.TITLE_LENGTH].replace(/[.()—]/g, ".")));
});

test("the readable copy shows the evidence and the ref as stored", () => {
  const md = toMarkdown(sampleFile(), "triage.json");
  assert.match(md, /`ISBN__9780872860179`/);
  assert.match(md, /authors: stored Allen Ginsberg; the ISBN's Allen Ginsberg/);
  assert.match(md, /work id `howl1`/);
});

test("toMarkdown survives a file with nothing in it", () => {
  const md = toMarkdown({ rows: [], notSearched: [] });
  assert.match(md, /# Books the refresh cannot unfreeze/);
  assert.equal(md.includes("## Not searched"), false);
});

test("describeSummary reports the two non-bucket tallies separately", () => {
  const text = describeSummary(summarize([{ bucket: BUCKETS.EDITION }], {
    notSearched: 3,
    failures: 54,
  }));
  assert.match(text, /1 classified/);
  assert.match(text, /not searched \(no answer, not a finding\): 3/);
  assert.match(text, /backfill failures \(quota, not refusals\): 54/);
});
