/**
 * @file The one-work ref repair's verdicts, with no database and no network.
 *
 * The cases are the ones #290 produced: an id typed in good faith that named
 * something else.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { refusalReason, refUpdate } = require("./work_ref_repair");

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
