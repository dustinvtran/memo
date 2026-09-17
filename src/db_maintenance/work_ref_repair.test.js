/**
 * @file The one-work ref repair's verdicts, with no database and no network.
 *
 * The cases are the ones #290 produced: an id typed in good faith that named
 * something else.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { refusalReason, refUpdate, unlinkRefusalReason, unlinkUpdate } = require("./work_ref_repair");

const games = { type: "games", retrievePrefix: "igdb" };
const books = { type: "books", retrievePrefix: "ISBN" };
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
    set: { apiRefs: ["igdb__12571"] },
    unset: { metadataUpdatedDate: "" },
  });
});

test("the retitle is written from the API's spelling, not from what was typed", () => {
  assert.deepEqual(refUpdate(work("Ultimate Doom: Episode 4 Only"), "igdb__10192", "The Ultimate Doom"), {
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

