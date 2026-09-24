/**
 * @file The one-work ref repair's verdicts, with no database and no network.
 *
 * The cases are the ones #290 produced: an id typed in good faith that named
 * something else.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { COLLECTIONS } = require("./work_collections");
const {
  refCandidates,
  chooseRef,
  refusalReason,
  refUpdate,
  unlinkRefusalReason,
  unlinkUpdate,
  staleAfterRepoint,
  staleAfterWidening,
  isWidening,
} = require("./work_ref_repair");

const games = { type: "games", retrievePrefix: "igdb" };
const books = { type: "books", retrievePrefix: "ISBN" };
const films = { type: "films", retrievePrefix: "tmdb" };
const work = (title, apiRefs = []) => ({ _id: "w1", englishTranslatedTitle: title, apiRefs });
const why = (args) => refusalReason({ collection: games, ...args });

test("a work and a ref that agree is allowed", () => {
  assert.equal(
    why({ work: work("Kingdom Hearts"), ref: "igdb__9", retrieved: { englishTranslatedTitle: "Kingdom Hearts" } }),
    undefined
  );
});

/**
 * The check the whole tool exists for. `Kingdom Hearts` under Kingdom Hearts
 * III's id is #290, and it was typed by a person who believed it.
 */
test("a ref naming a different work is refused, not warned about", () => {
  const reason = why({
    work: work("Kingdom Hearts"),
    ref: "igdb__9",
    retrieved: { englishTranslatedTitle: "Kingdom Hearts III" },
  });
  assert.match(reason, /Kingdom Hearts III/);
  assert.match(reason, /not this work/);
});

test("a placeholder is not an id", () => {
  assert.match(why({ work: work("A"), ref: "igdb__N/A" }), /not a usable ref/);
  assert.match(why({ work: work("A"), ref: "undefined__undefined" }), /not a usable ref/);
});

test("a ref of the wrong type is refused before anything is asked", () => {
  assert.match(why({ work: work("A"), ref: "tmdb__5" }), /retrieved by igdb__, not tmdb__/);
});

/** Handing one id to a second work is manufacturing #340 on purpose. */
test("an id another work already holds is refused", () => {
  const reason = why({
    work: work("Among Us"),
    ref: "igdb__127111",
    otherHolders: [{ englishTranslatedTitle: "The Wolf Among Us" }],
  });
  assert.match(reason, /already names The Wolf Among Us/);
});

/**
 * Not a repointing tool. A work that already answers is not the population
 * this is for, and replacing a good ref silently is how it becomes a bad one.
 */
test("a work that already has an identity ref is left alone", () => {
  assert.match(
    why({ work: work("A", ["igdb__1"]), ref: "igdb__2", retrieved: { englishTranslatedTitle: "A" } }),
    /already has igdb__1/
  );
});

test("a secondary ref does not count as already having one", () => {
  assert.equal(
    why({ work: work("A", ["hltb__5"]), ref: "igdb__2", retrieved: { englishTranslatedTitle: "A" } }),
    undefined
  );
});

test("an API that will not answer is a refusal rather than a write", () => {
  assert.match(why({ work: work("A"), ref: "igdb__2", retrieveError: "404 not found" }), /would not answer/);
  assert.match(why({ work: work("A"), ref: "igdb__2" }), /names nothing/);
});

test("a work that is not there is said so plainly", () => {
  assert.match(why({ work: undefined, ref: "igdb__2" }), /no work with that id/);
});

/** Books are retrieved by ISBN__ and carry google__ for the same ISBN. */
test("a books work takes its retrieve prefix", () => {
  assert.equal(
    refusalReason({ collection: books, work: work("A"), ref: "ISBN__9780765310019", retrieved: { englishTranslatedTitle: "A" } }),
    undefined
  );
  assert.match(
    refusalReason({ collection: books, work: work("A"), ref: "google__x" }),
    /retrieved by ISBN__/
  );
});

test("the write appends the ref and forces a refresh", () => {
  assert.deepEqual(refUpdate(work("A", ["hltb__N/A"]), "igdb__9"), {
    cleared: [],
    set: { apiRefs: ["hltb__N/A", "igdb__9"] },
    unset: { metadataUpdatedDate: "" },
  });
});

/** The placeholders it keeps are a record of where the work has been. */
test("the write keeps what was already there rather than replacing it", () => {
  assert.deepEqual(refUpdate({ apiRefs: undefined }, "igdb__9").set.apiRefs, ["igdb__9"]);
});

test("a title disagreement is refused when nobody has said they checked", () => {
  assert.match(
    why({ work: work("Portal 2: Coop"), ref: "igdb__72", retrieved: { englishTranslatedTitle: "Portal 2" } }),
    /one of them is not this work/
  );
});

/**
 * The reason `retitleWorkTo` is not a `--force`: it has to be the title the
 * API just gave, so it can only be filled in by somebody who read the answer.
 */
test("naming the API's own title is what gets past the guard", () => {
  assert.equal(
    why({
      work: work("Portal 2: Coop"),
      ref: "igdb__72",
      retitleWorkTo: "Portal 2",
      retrieved: { englishTranslatedTitle: "Portal 2" },
    }),
    undefined
  );
});

test("a retitle that is not what the ref names is refused like a wrong id", () => {
  assert.match(
    why({
      work: work("Portal 2: Coop"),
      ref: "igdb__72",
      retitleWorkTo: "Portal",
      retrieved: { englishTranslatedTitle: "Portal 2" },
    }),
    /is not what igdb__72 names/
  );
});

/** `titlesAgree` forgives an article and a trailing parenthetical, so this does. */
test("the retitle is compared the way every other title here is", () => {
  assert.equal(
    why({
      work: work("Ultimate Doom: Episode 4 Only"),
      ref: "igdb__10192",
      retitleWorkTo: "Ultimate Doom",
      retrieved: { englishTranslatedTitle: "The Ultimate Doom" },
    }),
    undefined
  );
});

/** It is ignored when there was nothing to get past, rather than applied. */
test("a retitle on a work whose title already agrees changes nothing", () => {
  assert.equal(
    why({ work: work("Nioh"), ref: "igdb__12571", retitleWorkTo: "Nioh", retrieved: { englishTranslatedTitle: "Nioh" } }),
    undefined
  );
  assert.deepEqual(refUpdate(work("Nioh"), "igdb__12571"), {
    cleared: [],
    set: { apiRefs: ["igdb__12571"] },
    unset: { metadataUpdatedDate: "" },
  });
});

test("the retitle is written from the API's spelling, not from what was typed", () => {
  assert.deepEqual(refUpdate(work("Ultimate Doom: Episode 4 Only"), "igdb__10192", "The Ultimate Doom"), {
    cleared: [],
    set: { apiRefs: ["igdb__10192"], englishTranslatedTitle: "The Ultimate Doom" },
    unset: { metadataUpdatedDate: "" },
  });
});

/**
 * #378's population: the ref is not missing, it is wrong. `Her Story` carried
 * `The Sych Story: Ded's Story`'s id and `Until Dawn` carried `Dawn of War
 * II`'s — both retrieve cleanly, so nothing above this line would have looked
 * at them, and the refusal for a work that already answers is exactly what
 * kept them broken.
 */
test("naming the wrong ref you are taking off is what allows a replacement", () => {
  assert.equal(
    why({
      work: work("Her Story", ["igdb__170227"]),
      ref: "igdb__11346",
      replacesRef: "igdb__170227",
      retrieved: { englishTranslatedTitle: "Her Story" },
    }),
    undefined
  );
});

test("a replacesRef that is not the ref the work carries is refused", () => {
  assert.match(
    why({
      work: work("Her Story", ["igdb__170227"]),
      ref: "igdb__11346",
      replacesRef: "igdb__999",
      retrieved: { englishTranslatedTitle: "Her Story" },
    }),
    /not the ref this work carries \(igdb__170227\)/
  );
});

test("a replacesRef on a work with nothing to replace is refused", () => {
  assert.match(
    why({ work: work("A"), ref: "igdb__2", replacesRef: "igdb__1", retrieved: { englishTranslatedTitle: "A" } }),
    /carries no igdb__ ref to replace/
  );
});

test("replacing a ref with itself is refused rather than written", () => {
  assert.match(
    why({ work: work("A", ["igdb__1"]), ref: "igdb__1", replacesRef: "igdb__1", retrieved: { englishTranslatedTitle: "A" } }),
    /nothing to replace/
  );
});

/** A replacement is not a way around the check the tool exists for. */
test("a replacement is still refused when the new ref names something else", () => {
  assert.match(
    why({
      work: work("Until Dawn", ["igdb__466"]),
      ref: "igdb__7609",
      replacesRef: "igdb__466",
      retrieved: { englishTranslatedTitle: "Warhammer 40,000: Dawn of War II" },
    }),
    /not this work/
  );
});

test("a replacement cannot put two works under one id either", () => {
  assert.match(
    why({
      work: work("Kingdom: Season 1", ["tmdb__63333"]),
      ref: "igdb__7",
      replacesRef: "tmdb__63333",
      otherHolders: [{ englishTranslatedTitle: "Kingdom: Season 2" }],
      retrieved: { englishTranslatedTitle: "Kingdom" },
    }),
    /already names Kingdom: Season 2/
  );
});

/**
 * The reason a replaced ref cannot be kept the way a placeholder is:
 * `findApiRef` takes the first of its prefix, so a wrong id left in the array
 * is a live id the next refresh can retrieve.
 */
test("the replaced ref is dropped, and everything else is kept", () => {
  const { set } = refUpdate(work("A", ["hltb__5", "igdb__170227"]), "igdb__11346", undefined, "igdb__170227");
  assert.deepEqual(set.apiRefs, ["hltb__5", "igdb__11346"]);
});

test("without a replacesRef the write still only appends", () => {
  const { set } = refUpdate(work("A", ["hltb__5"]), "igdb__11346", undefined, undefined);
  assert.deepEqual(set.apiRefs, ["hltb__5", "igdb__11346"]);
});

// --- a row that names more than one id (#388) ---

/**
 * The queue is what a person wrote, in the order they wrote it. A worklist
 * field left blank is absent rather than an empty claim, which is what lets
 * propose_work_refs.js's `"ref": ""` rows be handed over unedited.
 */
test("a flat row is a queue of one, and its retitle belongs to that one id", () => {
  assert.deepEqual(refCandidates({ work: "w1", ref: "igdb__9", retitleWorkTo: "Portal 2" }), [
    { ref: "igdb__9", retitleWorkTo: "Portal 2", replacesRef: undefined },
  ]);
  assert.deepEqual(refCandidates({ work: "w1", ref: "", retitleWorkTo: "", entryTitle: "" }), []);
  assert.deepEqual(refCandidates(undefined), []);
});

test("alternates are tried after the first, in the order given", () => {
  assert.deepEqual(
    refCandidates({ work: "w1", ref: "tmdb__1", alternates: ["tmdb__2", "tmdb__3"] }).map((c) => c.ref),
    ["tmdb__1", "tmdb__2", "tmdb__3"]
  );
});

/**
 * #388's second invariant, at the level where it is decided. `retitleWorkTo`
 * says a person read *that* id's answer, so it cannot be handed to an id
 * nobody looked at; `replacesRef` names the ref coming off the work, which is
 * the same ref whichever candidate goes on, so it travels.
 */
test("an alternate inherits replacesRef and never a retitle", () => {
  const queue = refCandidates({
    work: "w1",
    ref: "igdb__9",
    retitleWorkTo: "Portal 2",
    replacesRef: "igdb__1",
    alternates: ["igdb__10"],
  });
  assert.deepEqual(queue[1], { ref: "igdb__10", retitleWorkTo: undefined, replacesRef: "igdb__1" });
});

test("an alternate may carry its own retitle, and its own replacesRef", () => {
  const queue = refCandidates({
    work: "w1",
    ref: "igdb__9",
    replacesRef: "igdb__1",
    alternates: [{ ref: "igdb__10", retitleWorkTo: "Portal 2" }, { ref: "igdb__11", replacesRef: "igdb__2" }],
  });
  assert.deepEqual(queue[1], { ref: "igdb__10", retitleWorkTo: "Portal 2", replacesRef: "igdb__1" });
  assert.deepEqual(queue[2], { ref: "igdb__11", retitleWorkTo: undefined, replacesRef: "igdb__2" });
});

/**
 * The proposal file's premise, kept: `candidates` is what the search found and
 * `ref` is what a person chose from it. Reading the array would make `--from`
 * write a raw search's first hit, which is #290 arriving by a new route and
 * the reason nothing in propose_work_refs.js chooses in the first place.
 */
test("the candidates a search wrote are not a source of ids", () => {
  const proposalRow = {
    kind: "work",
    work: "w1",
    candidates: [{ ref: "tmdb__1", score: 95 }, { ref: "tmdb__2", score: 60 }],
    ref: "",
    alternates: [],
    retitleWorkTo: "",
  };
  assert.deepEqual(refCandidates(proposalRow), []);
});

/** An entry row is link_entry.js's; nothing here would know what to do with it. */
test("a row naming no work still yields whatever ids it names", () => {
  assert.deepEqual(refCandidates({ kind: "entry", entry: "e1", ref: "" }), []);
});

/**
 * The guard, wired the way scripts/set_work_ref.js wires it: a table of what
 * each id answers stands in for the retrieve, and the verdict is the real
 * `refusalReason`. That is the claim worth testing — an alternate is checked,
 * not waved through.
 */
const guardedAgainst = (theWork, answers, collection = games) => async ({ ref, retitleWorkTo, replacesRef }) => {
  const retrieved = answers[ref];
  return {
    reason: refusalReason({ collection, work: theWork, ref, retitleWorkTo, replacesRef, retrieved }),
    retrieved,
  };
};

/**
 * The case #388 was found by, and the one the proposal's header predicts: the
 * search led with the wrong film and the second candidate is the right one.
 */
test("a refused first candidate falls through to a second that passes", async () => {
  const hero = work("Hero");
  const { taken, retrieved, refused } = await chooseRef(
    { work: "w1", ref: "tmdb__1", alternates: ["tmdb__2"] },
    guardedAgainst(
      hero,
      {
        tmdb__1: { englishTranslatedTitle: "THE RIBBON HERO" },
        tmdb__2: { englishTranslatedTitle: "Hero" },
      },
      films
    )
  );

  assert.equal(taken.ref, "tmdb__2");
  assert.deepEqual({ ...retrieved }, { englishTranslatedTitle: "Hero" });
  // Why the earlier one was not taken, in the guard's own words.
  assert.equal(refused.length, 1);
  assert.equal(refused[0].ref, "tmdb__1");
  assert.match(refused[0].reason, /THE RIBBON HERO/);
  assert.match(refused[0].reason, /not this work/);
});

/** A queue is not a relaxation: every id can still be refused, and then is. */
test("a row every candidate refuses is refused, and says so about each", async () => {
  const { taken, refused } = await chooseRef(
    { work: "w1", ref: "igdb__1", alternates: ["igdb__2", "igdb__N/A"] },
    guardedAgainst(work("Hero"), {
      igdb__1: { englishTranslatedTitle: "DCS World: Hero Campaign" },
      igdb__2: { englishTranslatedTitle: "Big Hero 6" },
    })
  );

  assert.equal(taken, undefined);
  assert.deepEqual(
    refused.map((attempt) => attempt.ref),
    ["igdb__1", "igdb__2", "igdb__N/A"]
  );
  assert.match(refused[0].reason, /not this work/);
  assert.match(refused[1].reason, /not this work/);
  assert.match(refused[2].reason, /not a usable ref/);
});

/**
 * #388's second invariant, end to end. `Portal 2: Coop` is a right id under a
 * name of its owner's, and `retitleWorkTo` is how a person says they read
 * IGDB's answer for *that* id. The alternate is a different id nobody read, so
 * it meets the title guard with nothing, and the guard refuses it — which is
 * the behaviour, not a gap in it.
 */
test("an alternate does not inherit the first candidate's retitle", async () => {
  const coop = work("Portal 2: Coop");
  const answers = { igdb__73: { englishTranslatedTitle: "Portal 2" } };

  const { taken, refused } = await chooseRef(
    { work: "w1", ref: "igdb__72", retitleWorkTo: "Portal 2", alternates: ["igdb__73"] },
    guardedAgainst(coop, answers)
  );
  assert.equal(taken, undefined);
  assert.match(refused[0].reason, /igdb__72 names nothing/);
  assert.match(refused[1].reason, /one of them is not this work/);

  // And the way past it is the alternate carrying its own, which is a person
  // having read the answer for the id that is actually going to be written.
  const second = await chooseRef(
    {
      work: "w1",
      ref: "igdb__72",
      retitleWorkTo: "Portal 2",
      alternates: [{ ref: "igdb__73", retitleWorkTo: "Portal 2" }],
    },
    guardedAgainst(coop, answers)
  );
  assert.equal(second.taken.ref, "igdb__73");
  assert.equal(second.taken.retitleWorkTo, "Portal 2");
});

/** Each candidate costs a retrieve, so the queue stops at the first that passes. */
test("nothing past the accepted candidate is asked about", async () => {
  const asked = [];
  const { taken } = await chooseRef(
    { work: "w1", ref: "igdb__9", alternates: ["igdb__10", "igdb__11"] },
    async ({ ref }) => {
      asked.push(ref);
      return { reason: undefined };
    }
  );

  assert.equal(taken.ref, "igdb__9");
  assert.deepEqual([...asked], ["igdb__9"]);
});

// --- taking a ref off ---

const whyNot = (args) => unlinkRefusalReason({ collection: games, ...args });

/**
 * #378's eight: ids that were real and that the API has since dropped. They
 * were asked twice before being believed, because #375 had just established
 * that one empty answer proves nothing.
 */
test("a ref nothing will answer for can be taken off", () => {
  assert.equal(
    whyNot({ work: work("Metal Slug", ["igdb__100053", "hltb__5928"]), unlinkRef: "igdb__100053", retrieveError: "404 not found" }),
    undefined
  );
});

/** The mistake this operation invites: unlinking the wrong row of a worklist. */
test("a ref that still names this work is refused", () => {
  assert.match(
    whyNot({
      work: work("Her Story", ["igdb__11346"]),
      unlinkRef: "igdb__11346",
      retrieved: { englishTranslatedTitle: "Her Story" },
    }),
    /still answers.*that is this work/s
  );
});

test("a ref that answers with something else is sent to replacesRef", () => {
  const reason = whyNot({
    work: work("Until Dawn", ["igdb__466"]),
    unlinkRef: "igdb__466",
    retrieved: { englishTranslatedTitle: "Warhammer 40,000: Dawn of War II" },
  });
  assert.match(reason, /wrong id, not a dead one/);
  assert.match(reason, /replacesRef/);
});

/** For the one case that is neither dead nor replaceable: no right id exists. */
test("naming what a live ref answers with strips it anyway", () => {
  assert.equal(
    whyNot({
      work: work("Until Dawn", ["igdb__466"]),
      unlinkRef: "igdb__466",
      becauseItNames: "Warhammer 40,000: Dawn of War II",
      retrieved: { englishTranslatedTitle: "Warhammer 40,000: Dawn of War II" },
    }),
    undefined
  );
});

test("a becauseItNames that is not what the ref answers with is refused", () => {
  assert.match(
    whyNot({
      work: work("Until Dawn", ["igdb__466"]),
      unlinkRef: "igdb__466",
      becauseItNames: "Something Else Entirely",
      retrieved: { englishTranslatedTitle: "Warhammer 40,000: Dawn of War II" },
    }),
    /is not what igdb__466 answers with/
  );
});

test("a ref the work does not carry is refused", () => {
  assert.match(
    whyNot({ work: work("A", ["igdb__1"]), unlinkRef: "igdb__2", retrieveError: "404" }),
    /does not carry igdb__2/
  );
});

/** Narrow on purpose: a placeholder identifies nothing and cannot go stale. */
test("only the ref the collection retrieves by can be taken off", () => {
  assert.match(
    whyNot({ work: work("A", ["hltb__5"]), unlinkRef: "hltb__5", retrieveError: "404" }),
    /not hltb__/
  );
});

test("the write drops only that ref, and leaves the rest alone", () => {
  const { set } = unlinkUpdate(work("A", ["igdb__100053", "hltb__5928"]), "igdb__100053");
  assert.deepEqual(set.apiRefs, ["hltb__5928"]);
});

/**
 * The opposite of `refUpdate`, which drops it so the next refresh fills what
 * the new ref answers. There is nothing here for a refresh to ask.
 */
test("an unlink leaves metadataUpdatedDate alone", () => {
  assert.equal("unset" in unlinkUpdate(work("A", ["igdb__1"]), "igdb__1"), false);
  assert.equal("metadataUpdatedDate" in unlinkUpdate(work("A", ["igdb__1"]), "igdb__1").set, false);
});


////////////////////////////////////////////////////////////////////////////////
// A repoint clears what a refresh would not replace (CLAUDE.md's repoint rule)
////////////////////////////////////////////////////////////////////////////////

const BOOKS = {
  type: "books",
  fillOnlyFields: ["releaseYear", "duration"],
  editionFields: ["duration"],
};

test("the fixture above is the descriptor the scripts actually load", () => {
  // Hand-built fixtures are how a rule quietly stops describing production.
  const real = COLLECTIONS.find((c) => c.type === "books");
  assert.deepEqual([...real.fillOnlyFields], [...BOOKS.fillOnlyFields]);
  assert.deepEqual([...real.editionFields], [...BOOKS.editionFields]);
});
const GAMES = { type: "games" };
const FILMS = { type: "films" };

test("staleAfterRepoint names the fields each type will not replace", () => {
  // #385: `releaseYear` is fill-only but is not the edition's, so a repoint
  // leaves it. Clearing it let the next refresh refill it from the new
  // printing, which replaced nineteen correct first-publication years.
  assert.deepEqual([...staleAfterRepoint(BOOKS)], ["duration"]);
  assert.deepEqual([...staleAfterRepoint(GAMES)], ["duration", "durationSource"]);
  assert.deepEqual([...staleAfterRepoint(FILMS)], []);
});

test("a replacesRef repoint clears the stale fields it finds", () => {
  const work = {
    _id: "w1",
    apiRefs: ["ISBN__old"],
    englishTranslatedTitle: "Numerical Linear Algebra",
    releaseYear: 2018,
    duration: 419,
  };
  const { set, unset, cleared } = refUpdate(work, "ISBN__new", undefined, "ISBN__old", BOOKS);
  assert.deepEqual([...set.apiRefs], ["ISBN__new"]);
  assert.deepEqual([...cleared], ["duration"]);
  assert.equal(unset.duration, "");
  assert.equal(unset.metadataUpdatedDate, "");
  // The year survives the repoint, and is the whole of #385's correction.
  assert.equal("releaseYear" in unset, false);
});

test("a field the work does not carry is not reported as cleared", () => {
  const work = { _id: "w1", apiRefs: ["ISBN__old"], duration: 419, imageUrl: "x" };
  const { cleared, unset } = refUpdate(work, "ISBN__new", undefined, "ISBN__old", BOOKS);
  assert.deepEqual([...cleared], ["duration"]);
  assert.equal(unset.imageUrl, undefined);
});

test("a games repoint takes durationSource with the duration", () => {
  const work = { _id: "w1", apiRefs: ["igdb__1"], duration: 780, durationSource: "igdb" };
  const { cleared } = refUpdate(work, "igdb__2", undefined, "igdb__1", GAMES);
  assert.deepEqual([...cleared], ["duration", "durationSource"]);
});

test("giving a ref to a work that had none clears nothing", () => {
  // Not a repoint: there is no previous id whose values these were.
  const work = { _id: "w1", apiRefs: [], releaseYear: 1997, duration: 356 };
  const { cleared, unset } = refUpdate(work, "ISBN__new", undefined, undefined, BOOKS);
  assert.deepEqual([...cleared], []);
  assert.deepEqual(Object.keys(unset), ["metadataUpdatedDate"]);
});

test("widening a work is a repoint for this purpose, with no replacesRef", () => {
  // `Resident Evil 4: Assignment Ada` -> `Resident Evil 4` keeps a playtime
  // measured for the part. CLAUDE.md names this exact pair.
  const work = {
    _id: "w1",
    apiRefs: [],
    englishTranslatedTitle: "Resident Evil 4: Assignment Ada",
    duration: 60,
    durationSource: "igdb",
  };
  const { cleared } = refUpdate(work, "igdb__2", "Resident Evil 4", undefined, GAMES);
  assert.deepEqual([...cleared], ["duration", "durationSource"]);
});

test("correcting a misspelling is not a widening and keeps the values", () => {
  // `McCabe & Mrs. McMiller` contains nothing of `McCabe & Mrs. Miller`.
  const work = {
    _id: "w1",
    apiRefs: [],
    englishTranslatedTitle: "McCabe & Mrs. McMiller",
    duration: 120,
  };
  const { cleared } = refUpdate(work, "tmdb__2", "McCabe & Mrs. Miller", undefined, GAMES);
  assert.deepEqual([...cleared], []);
});

test("a retitle to the same name is not a widening", () => {
  const work = { _id: "w1", apiRefs: [], englishTranslatedTitle: "Portal 2", duration: 60 };
  assert.equal(isWidening(work, "Portal 2"), false);
  assert.equal(isWidening(work, undefined), false);
});

test("isWidening is true only when the stored title is the new one plus something", () => {
  const work = { _id: "w1", englishTranslatedTitle: "Portal 2: Coop" };
  assert.equal(isWidening(work, "Portal 2"), true);
});

test("staleAfterWidening is the source-protected duration and nothing else", () => {
  // A books year and page count belong to an edition, and a widening does not
  // change the edition — #333's Robinson Crusoe 1719 -> 2019 is what clearing
  // them would invite.
  assert.deepEqual([...staleAfterWidening(BOOKS)], []);
  assert.deepEqual([...staleAfterWidening(GAMES)], ["duration", "durationSource"]);
  assert.deepEqual([...staleAfterWidening(FILMS)], []);
});

test("widening a book clears nothing, because the edition did not change", () => {
  // `A Comprehensive Introduction to Differential Geometry, Vol. 1` renamed to
  // the whole work, under the same ISBN: 489 pages is still that ISBN's.
  const work = {
    _id: "w1",
    apiRefs: ["ISBN__1"],
    englishTranslatedTitle: "A Comprehensive Introduction to Differential Geometry, Vol. 1",
    releaseYear: 1999,
    duration: 489,
  };
  const { cleared } = refUpdate(
    work,
    "ISBN__1",
    "A Comprehensive Introduction to Differential Geometry",
    undefined,
    BOOKS
  );
  assert.deepEqual([...cleared], []);
});

test("widening a game still clears the playtime measured for the part", () => {
  const work = {
    _id: "w1",
    apiRefs: [],
    englishTranslatedTitle: "Resident Evil 4: Assignment Ada",
    duration: 60,
    durationSource: "igdb",
  };
  const { cleared } = refUpdate(work, "igdb__2", "Resident Evil 4", undefined, GAMES);
  assert.deepEqual([...cleared], ["duration", "durationSource"]);
});

test("repointing a book clears the page count and keeps the year", () => {
  // The distinction: 419 pages describes a printing nobody is looking at any
  // more, while 2018 is when the book was written and does not move with the
  // ISBN. #385 is what clearing it cost.
  const work = { _id: "w1", apiRefs: ["ISBN__old"], releaseYear: 2018, duration: 419 };
  const { cleared } = refUpdate(work, "ISBN__new", undefined, "ISBN__old", BOOKS);
  assert.deepEqual([...cleared], ["duration"]);
});

test("a repoint that is also a widening clears the repoint's wider list", () => {
  const work = {
    _id: "w1",
    apiRefs: ["ISBN__old"],
    englishTranslatedTitle: "Some Book, Vol. 1",
    releaseYear: 2018,
    duration: 419,
  };
  const { cleared } = refUpdate(work, "ISBN__new", "Some Book", "ISBN__old", BOOKS);
  assert.deepEqual([...cleared], ["duration"]);
});
