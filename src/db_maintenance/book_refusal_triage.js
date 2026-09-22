/**
 * @file Which of the four things a refused book is, and which repair that
 * implies — decided from evidence, and answering "I cannot tell" when the
 * evidence does not reach.
 *
 * #385. `backfill_work_metadata.js --missing-only --only=books` retrieves
 * 270-odd due books and refuses 74. Every refusal is `mergeWork`'s #290 title
 * guard: the stored title disagrees with the one the ISBN answers with, so the
 * merge is declined and the work is frozen. None has refreshed since it was
 * stored, and #384's `--fail-on-refusal` cannot be turned on in
 * `.github/workflows/refresh_metadata.yml` until the 74 are gone.
 *
 * **Books are not #381 with a different number, and that is the whole reason
 * this file exists.** For films, tv and games a refusal meant one thing — the
 * owner's name for the right work had been stored on the work instead of the
 * entry — and 93 of them wanted the same repair. An ISBN names an *edition*,
 * so a refused book can be any of four different problems wanting three
 * different repairs, and the repairs are not interchangeable: renaming a work
 * that is filed under a genuinely different book leaves the wrong ISBN in
 * place, and repointing a work whose ISBN is right throws away a correct id.
 *
 * Pure and dependency-free like its neighbours, for the reason
 * ./book_ref_proposal.js is: this is the half that decides what a person will
 * be asked to approve, and scripts/triage_book_refusals.js is the half that
 * does the network calls and writes the file. ./book_refusal_triage.test.js
 * covers it with no install, no database and no API key.
 *
 * ## Nothing here writes, and nothing here approves
 *
 * The output is a proposal row in the shape the repair scripts already read —
 * `link_entry.js --from` for a rename, `set_work_ref.js --from` with
 * `replacesRef` for a repoint, `propose_book_refs.js` for a fresh ISBN — so an
 * approved row is applied without retyping. Every row lands with its approval
 * unset, and the `entryTitle` a rename needs is deliberately left blank:
 * `link_entry.js` is allowed near `*Entries` at all because every `entryTitle`
 * it writes was typed by hand, for that row, by the person whose row it is,
 * and a file that pre-filled them would be the sweep that rule forbids.
 *
 * ## Why the author check leads
 *
 * `titlesAgree` is loose by design and ./work_collections.js says at length
 * why. Here the two titles have *already* failed it — that is what a refusal
 * is — so the title tells us only that something is wrong, never which of the
 * four. The author is what separates them: a translation and a re-edition
 * share one, and a different book almost never does. 326 of the 328 books with
 * a gap carry an author, so this has teeth on essentially all of them, and
 * ./book_ref_proposal.js leans on the same fact for the same reason.
 *
 * So a known author conflict is read before the language and before the
 * titles. `こゝろ (Kokoro)` under *会津のこころ* is two Japanese titles, and
 * reading the script first would call it a translation of itself; the authors
 * disagree and it is a different book.
 *
 * ## What the author check cannot be asked, which the 2026-09-21 run found
 *
 * A conflict selects the one destructive repair here, so the cost of reading
 * one as a conflict when it is not is a `replacesRef` written against a work
 * whose ISBN was right. The first production run of this file made that call
 * seven times out of 34, and every one was the same name spelled another way:
 *
 *   - **In another script.** `Osamu Dazai` against `太宰治`, `Yasunari
 *     Kawabata` against `康成·川端`. No string comparison bridges those and
 *     none is attempted; what rescues those books is that the title the ISBN
 *     answered with was sitting in the stored title's own brackets, which is
 *     `glossNaming` below and is read before the author for that reason.
 *   - **In the other order.** `Dav Pilkey` against Google Books' `Pilkey Dav`.
 *   - **With a catalogue's parenthetical on it.** `Isaac Asimov` against
 *     `Isaac Asimov (Schriftsteller)`, which is #385's own flagship
 *     translation — `Foundation` under *Fondation* — filed as a different
 *     book entirely.
 *
 * The last two are answered in `authorAgreement`, and neither is a loosening
 * in the sense the surname fallback is: one compares the same words in either
 * order and the other drops a suffix that was never part of a name. Two people
 * who did not already share every part of one are still two people.
 *
 * ## Where it deliberately gives up
 *
 * A shared author with two unrelated titles is the one shape this cannot
 * resolve. *Dressing the Man* really is `The Fundamentals of Style` retitled,
 * and `Kafka on the Shore` really is not `Norwegian Wood`, and from here those
 * two look identical: same author, titles with nothing in common, both in
 * English. Guessing would be #290 arriving by a new route — a repair applied
 * to a book it was not meant for — so the row goes to `NEEDS_HUMAN` carrying
 * both readings and the evidence for each. The issue lists *Dressing the Man*
 * under the edition bucket because the owner knows the book; a script does
 * not, and saying so is cheaper than being wrong about it.
 *
 * `EDITION` is claimed only with something to point at: one title containing
 * the other, or an edition word in the answer. Anything less is a guess
 * wearing a bucket name.
 *
 * ## The fifth and sixth buckets
 *
 * The issue names four. Two more are here because folding them in would lose
 * something a person needs:
 *
 *   - `NEEDS_HUMAN`, which #385 asks for by name: better an explicit "I cannot
 *     tell" than a row that reads like a finding.
 *   - `SUBTITLE_TRAP`, which is **not a data problem at all** and must not be
 *     handed to a repair script. `google_search.js`'s `titleOf` joins title
 *     and subtitle as `"Title: Subtitle"` while `google.js`'s retrieve maps
 *     `englishTranslatedTitle: volumeInfo.title` alone, so a book stored under
 *     its full subtitled name matches the search candidate that put it there
 *     and then fails `titlesAgree` when the same ISBN is retrieved — `The Idea
 *     Factory: Bell Labs and the Great Age of American Innovation` retrieves
 *     as `The Idea Factory`. The ISBN is right, the stored title is right, and
 *     the two halves of the adapter disagree about what a title is. Repointing
 *     does not help and renaming would throw away a subtitle to work around a
 *     bug, so these carry no repair and are reported for the code fix.
 *
 * A book whose ISBN could not be looked up is not a bucket. It is an
 * unanswered question, it is counted separately by the script, and it never
 * reaches this file — see `classifyRefusal`'s contract below.
 */
const {
  comparableTitle,
  displayTitle,
  isEmptyValue,
} = require("./work_collections");

/**
 * The buckets, as #385 names them, plus the two above.
 *
 * The values are what goes in the file and what a person greps for, so they
 * are words rather than the issue's numbers: a row that says `different-book`
 * still says it after somebody reorders the list in the issue.
 */
const BUCKETS = {
  /** 1. A different edition of the right book. Repair: rename the work. */
  EDITION: "edition",
  /** 2. The right book in another language. Repair: a fresh English ISBN. */
  TRANSLATION: "translation",
  /** 3. The ISBN names another book. Repair: repoint, naming the ref it replaces. */
  DIFFERENT_BOOK: "different-book",
  /** 4. A shorter or longer name for the same thing. Repair: rename the work. */
  TITLE_LENGTH: "title-length",
  /** 5. The evidence does not reach. Repair: none — a person decides. */
  NEEDS_HUMAN: "needs-human",
  /** 6. The adapter's own title asymmetry. Repair: none — fix the code. */
  SUBTITLE_TRAP: "subtitle-trap",
};

/**
 * Which script applies an approved row of each bucket, and under which
 * operation. `null` is not an omission: it is the statement that no repair
 * script should be pointed at this row.
 */
const REPAIRS = {
  [BUCKETS.EDITION]: { script: "link_entry.js", op: "retitle" },
  [BUCKETS.TRANSLATION]: { script: "propose_book_refs.js", op: "repoint" },
  [BUCKETS.DIFFERENT_BOOK]: { script: "set_work_ref.js", op: "replacesRef" },
  [BUCKETS.TITLE_LENGTH]: { script: "link_entry.js", op: "retitle" },
  [BUCKETS.NEEDS_HUMAN]: null,
  [BUCKETS.SUBTITLE_TRAP]: null,
};

/**
 * The refusal message `work_metadata_merge.js`'s `titleConflict` builds, read
 * back into its two titles.
 *
 * Worth parsing rather than re-deriving because a backfill `--json` report
 * already holds it for all 74, which makes the stored title and the title the
 * ISBN answers with free — no Google Books call, against a budget of about a
 * thousand a day. The script still looks each ISBN up for the author and the
 * language, but a run that only needs the titles need not spend anything.
 *
 * Anchored and non-greedy so a stored title containing the phrase cannot
 * swallow the rest of the line. Returns undefined rather than a half-parsed
 * pair when the message is not that message — a caller that gets undefined has
 * a refusal from some other guard and should say so, not guess.
 * @type {(message: unknown) => { storedTitle: string, refTitle: string } | undefined}
 */
const parseRefusal = (message) => {
  const matched = /^refused: stored title "(.*)" but the apiRef names "(.*)" — /.exec(
    String(message ?? "")
  );
  if (!matched) return undefined;
  return { storedTitle: matched[1], refTitle: matched[2] };
};

/**
 * How two titles sit against each other once `comparableTitle` has had them.
 *
 * Containment is the interesting answer and the reason this is not just
 * `titlesAgree`. That function refuses containment deliberately — "one title
 * containing the other" is the shape a search-result mistake takes, so it
 * stays a disagreement — which is right for a guard deciding whether to write,
 * and is exactly the distinction a triage wants back. `Howl and Other Poems`
 * under *Howl* is bucket 4 because of it.
 *
 * `equal` should be unreachable from a real refusal, since the guard would
 * have let it through, and is reported honestly rather than asserted away: it
 * is what a stale report looks like after somebody has already fixed the row.
 * @type {(stored: unknown, ref: unknown) => "equal"|"stored-contains-ref"|"ref-contains-stored"|"disjoint"|"unknown"}
 */
const titleRelation = (stored, ref) => {
  const ours = comparableTitle(stored);
  const theirs = comparableTitle(ref);
  if (ours === "" || theirs === "") return "unknown";
  if (ours === theirs) return "equal";
  if (ours.includes(theirs)) return "stored-contains-ref";
  if (theirs.includes(ours)) return "ref-contains-stored";
  return "disjoint";
};

/**
 * The English name a stored title carries in brackets, when that name is
 * exactly the title the ISBN answers with.
 *
 * A work whose own name is not in the Latin alphabet is stored here with a
 * gloss after it — `人間失格 (No Longer Human)`, `雪国 (Snow Country)`,
 * `走ることについて語るときに僕の語ること (What I Talk About When I Talk About
 * Running)`. `comparableTitle` drops one trailing parenthetical, which is
 * right for the `(Series, #1)` and `(1996)` it was written for and throws away
 * the only half of these titles a Google Books answer could ever match. So
 * every one of them reaches `titleRelation` as `disjoint` and is judged on its
 * authors instead — and the author is `Osamu Dazai` against `太宰治`, two
 * spellings of one name that no string comparison bridges. Three books were
 * filed as a different book entirely on that reading and one as needing a
 * human, when the ISBN had answered with the stored title's own gloss.
 *
 * **Equality, never containment.** Most of these brackets hold a series
 * marker rather than a title, and `Holes (Holes, #1)` must not be read as
 * naming anything. An exact match after `comparableTitle` is not a
 * resemblance: the bracket holds the title the ISBN gave back, so the two
 * name one book whatever the authors are spelled like. Containment would
 * re-admit every series marker and is the shape of mistake #290 is.
 *
 * Returns the gloss as stored, for the reasoning to quote, or undefined.
 * @type {(storedTitle: unknown, refTitle: unknown) => string | undefined}
 */
const glossNaming = (storedTitle, refTitle) => {
  const matched = /[([]([^()[\]]+)[)\]]\s*$/.exec(String(storedTitle ?? "").trim());
  if (!matched) return undefined;
  const gloss = matched[1].trim();
  const compared = comparableTitle(gloss);
  if (compared === "" || compared !== comparableTitle(refTitle)) return undefined;
  return gloss;
};

/**
 * Whether this refusal is the adapter disagreeing with itself rather than the
 * data being wrong.
 *
 * The test is the exact pair of code paths: `titleOf` in
 * `../api/utils/external_api_adapters/books/google_search.js` joins with
 * `": "`, and the retrieve in that folder's `google.js` maps the bare
 * `volumeInfo.title`. So a stored title that matches the *joined* form while
 * failing the bare one was written by a search and is refused by a retrieve,
 * and nothing about the book is wrong.
 *
 * It needs the raw `volumeInfo.subtitle`, which the retrieve does not surface
 * — the script reads the volumes endpoint directly for this and for the
 * language. With no subtitle in hand the answer is a plain `false`: there is
 * no trap without one, and this must never be inferred from a colon in the
 * stored title, which is a normal thing for a book's own name to contain.
 * @type {(evidence: { storedTitle?: unknown, refTitle?: unknown, refSubtitle?: unknown }) => boolean}
 */
const isSubtitleTrap = ({ storedTitle, refTitle, refSubtitle } = {}) => {
  if (isEmptyValue(refSubtitle) || typeof refSubtitle !== "string") return false;
  const stored = comparableTitle(storedTitle);
  if (stored === "") return false;
  const joined = comparableTitle(`${String(refTitle ?? "")}: ${refSubtitle}`);
  return stored === joined && stored !== comparableTitle(refTitle);
};

/**
 * Whether the two author lists agree, disagree, or have not said.
 *
 * Compared the way ./book_ref_proposal.js compares them, and for the same
 * reason: a name is spelled with and without a middle initial, with the
 * surname first, and with marks this drops. Overlap of one name is agreement —
 * an edition that adds a translator or an illustrator has not changed hands.
 *
 * `unknown` when either side is silent, never `conflict`. Nothing was
 * compared, so there is nothing to conclude, and calling silence a conflict
 * would file every author-less book under "a different book entirely" and
 * propose repointing all of them.
 *
 * **The surname fallback, which is not politeness.** Reducing a whole name to
 * one string makes `J.D. Salinger` and `Jerome David Salinger` disagree, and
 * a French edition's record spells an author out where ours abbreviates. In
 * ./book_ref_proposal.js the same comparison only ever *rejects a candidate*,
 * so being strict costs a suggestion; here a conflict is what selects the
 * repoint bucket, so being strict costs a wrong `replacesRef` written against
 * a book that merely wanted an English edition. The two errors are not the
 * same size, and this one leans the cheap way: a surname in common is taken as
 * agreement, which can only ever move a row *out* of the destructive bucket
 * and into one where a person looks.
 *
 * Three characters at least, so a shared initial is not a shared author, and
 * the last token because that is where a surname is in both orders this sees
 * — a one-token name like `夏目漱石` is its own surname and matches whole.
 * @type {(ours: unknown, theirs: unknown) => "shared"|"conflict"|"unknown"}
 */
const authorAgreement = (ours, theirs) => {
  const mine = comparableNames(ours);
  const yours = comparableNames(theirs);
  if (mine.length === 0 || yours.length === 0) return "unknown";

  if (mine.some(({ full }) => yours.some((other) => other.full === full))) {
    return "shared";
  }

  // The same words in the other order are the same person. A catalogue files
  // an author surname-first as readily as given-name-first, and both spellings
  // reach this function unlabelled — `Dav Pilkey` stored against Google Books'
  // `Pilkey Dav` for the French Capitaine Bobette. The full strings differ and
  // the last word is the *given* name on one side, so both tests below it miss
  // and two translations were filed as different books. This is an exact match
  // on the same words rather than a loosening: nothing here calls two people
  // one that did not already share every part of a name.
  const theirWords = new Set(yours.map(({ words }) => words));
  if (mine.some(({ words }) => theirWords.has(words))) return "shared";

  const theirSurnames = new Set(
    yours.map(({ surname }) => surname).filter((name) => name.length >= 3)
  );
  return mine.some(
    ({ surname }) => surname.length >= 3 && theirSurnames.has(surname)
  )
    ? "shared"
    : "conflict";
};

/**
 * Each name as the two things the comparison above wants: the whole of it with
 * everything but letters and digits gone, and its last whitespace-separated
 * word given the same treatment. Split before stripping, or there is no last
 * word left to find.
 * @type {(names: unknown) => Array<{ full: string, surname: string }>}
 */
const comparableNames = (names) =>
  (Array.isArray(names) ? names : [])
    .map((name) =>
      withoutTrailingParenthetical(
        String(name ?? "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/\p{Mark}/gu, "")
          .trim()
      )
    )
    .filter((name) => name !== "")
    .map((name) => {
      const words = name.split(/\s+/);
      const bare = (text) => text.replace(/[^\p{Letter}\p{Number}]/gu, "");
      return {
        full: bare(name),
        surname: bare(words[words.length - 1]),
        // Sorted, so the same words in either order reduce to one string.
        // See `authorAgreement`: `Pilkey Dav` is `Dav Pilkey`.
        words: words.map(bare).filter((word) => word !== "").sort().join(" "),
      };
    })
    .filter(({ full }) => full !== "");

/**
 * A name with a trailing `(...)` taken off, which is what a catalogue puts
 * there rather than part of the name.
 *
 * Google Books answers `Fondation`'s author as `Isaac Asimov (Schriftsteller)`
 * — a German disambiguator on a French edition — and that suffix is the whole
 * of the difference from the stored `Isaac Asimov`. Left on, it beats both
 * comparisons above: the full strings differ, and the last word is
 * `schriftsteller` rather than `asimov`, so #385's own flagship translation
 * was filed as a different book and proposed for a repoint.
 *
 * `comparableTitle` in ./work_collections.js drops a trailing parenthetical
 * from a title for the same reason and this is the same operation on a name,
 * kept local because a name loses only the one: `(Schriftsteller)` is a role
 * and `Title (Series, #1) (1996)` is two facts, so the title's loop is the
 * greedier of the two and greedier than a name wants.
 * @type {(name: string) => string}
 */
const withoutTrailingParenthetical = (name) =>
  name.replace(/\s*[([][^()[\]]*[)\]]$/, "").trim() || name;

/**
 * The words a printing puts in a title when it is the same book again.
 *
 * Only ever used as corroboration for a bucket the titles already support —
 * an edition word alone would call `The Second World War` a re-edition. The
 * list is the vocabulary seen on the refusals in #385 and #344 rather than a
 * general one, because a longer list is a wronger list here.
 */
const EDITION_WORDS = [
  "edition",
  "revised",
  "reprint",
  "printing",
  "abridged",
  "unabridged",
  "illustrated",
  "annotated",
  "anniversary",
  "paperback",
  "hardcover",
  "omnibus",
  "boxed set",
  "box set",
  "advantage",
  "international",
  "student",
];

/** @type {(title: unknown) => string | undefined} */
const editionMarker = (title) => {
  const text = String(title ?? "").toLowerCase();
  return EDITION_WORDS.find((word) => text.includes(word));
};

/**
 * Whether a language tag is a language other than English.
 *
 * Google Books answers `en`, `en-GB`, `fr`, `ja`. Absent is not English — it
 * is absent — and is reported as such so the caller does not read a missing
 * field as evidence of anything.
 * @type {(language: unknown) => boolean | undefined}
 */
const isNonEnglish = (language) => {
  const tag = String(language ?? "").trim().toLowerCase();
  if (tag === "") return undefined;
  return !tag.startsWith("en");
};

/**
 * The bucket one refused book belongs in, with the evidence that put it there.
 *
 * **Contract: this is only ever called for a book whose ISBN was answered.** A
 * lookup that failed — a 429 partway through a crawl, or the `EMPTY_LOOKUP`
 * #375 added so `retrying` can see an empty `200` — is an unanswered question,
 * and an unanswered question is not a finding. The script counts those per
 * book and reports them as "not searched"; passing one here would invent a
 * classification out of a call that never landed, which is the failure mode
 * ./book_ref_proposal.js was written around and the one #385 warns about
 * twice. `refTitle` missing therefore yields `NEEDS_HUMAN` with a reason that
 * says the evidence is absent, rather than a quiet default.
 *
 * The order is the argument. Each test is read before the ones below it
 * because it is the stronger evidence, not because it is the commoner case:
 *
 *   1. The subtitle trap, because the book is not wrong at all.
 *   2. The stored title's bracketed gloss being exactly the answer, because
 *      two titles that match are stronger evidence than two author lists that
 *      do not — and the books this catches are the ones whose authors are
 *      spelled in another script, where the author list proves nothing.
 *   3. A known author conflict, because two people who share no author are
 *      not one book in two languages however the titles look.
 *   4. A non-English answer with a shared author, which is a translation.
 *   5. Containment, which is one name for one book.
 *   6. What is left, which is either an edition with a word to prove it or a
 *      row for a person.
 *
 * @type {(evidence: {
 *   storedTitle?: unknown, refTitle?: unknown, refSubtitle?: unknown,
 *   storedAuthors?: unknown, refAuthors?: unknown, refLanguage?: unknown,
 * }) => { bucket: string, reasoning: string, evidence: object }}
 */
const classifyRefusal = (evidence = {}) => {
  const {
    storedTitle,
    refTitle,
    refSubtitle,
    storedAuthors,
    refAuthors,
    refLanguage,
  } = evidence;

  const authors = authorAgreement(storedAuthors, refAuthors);
  const relation = titleRelation(storedTitle, refTitle);
  const nonEnglish = isNonEnglish(refLanguage);
  const marker = editionMarker(refTitle);
  const subtitleTrap = isSubtitleTrap({ storedTitle, refTitle, refSubtitle });
  const gloss = glossNaming(storedTitle, refTitle);
  const seen = {
    titleRelation: relation,
    authors,
    refLanguage: refLanguage ?? null,
    editionMarker: marker ?? null,
    subtitleTrap,
    titleGloss: gloss ?? null,
  };
  const as = (bucket, reasoning) => ({ bucket, reasoning, evidence: seen });

  if (comparableTitle(refTitle) === "") {
    return as(
      BUCKETS.NEEDS_HUMAN,
      "The ISBN returned no title, so nothing was compared and nothing is " +
        "concluded. This is an absent answer, not a finding."
    );
  }

  if (subtitleTrap) {
    return as(
      BUCKETS.SUBTITLE_TRAP,
      `The stored title is this volume's title and subtitle joined, which is ` +
        `what a search wrote and what a retrieve cannot match. The ISBN and ` +
        `the stored title are both right; the adapter disagrees with itself. ` +
        `No data repair — see the note on google_search.js's titleOf.`
    );
  }

  if (gloss !== undefined) {
    return as(
      marker ? BUCKETS.EDITION : BUCKETS.TITLE_LENGTH,
      `The stored title carries "${gloss}" in brackets and that is exactly ` +
        `the title the ISBN answers with, so the two name one book under its ` +
        `own name and its English one. Rename the work to the API's title, ` +
        `keeping the owner's on the entry.`
    );
  }

  if (authors === "conflict") {
    return as(
      BUCKETS.DIFFERENT_BOOK,
      `The ISBN answers "${refTitle}" by a different author than the stored ` +
        `book's, so it names another book rather than another edition or a ` +
        `translation. Repoint it, naming the ref being replaced.`
    );
  }

  if (nonEnglish === true && authors === "shared") {
    return as(
      BUCKETS.TRANSLATION,
      `The ISBN is an edition in "${refLanguage}" by the same author, so the ` +
        `stored English title is right and the edition is not. Wants a fresh ` +
        `English ISBN rather than a rename.`
    );
  }

  if (nonEnglish === true) {
    return as(
      BUCKETS.NEEDS_HUMAN,
      `The ISBN is an edition in "${refLanguage}", but no author is recorded ` +
        `on both sides, so a translation of this book cannot be told from a ` +
        `different book in that language.`
    );
  }

  if (relation === "stored-contains-ref" || relation === "ref-contains-stored") {
    const longer = relation === "stored-contains-ref" ? "stored title" : "ISBN's title";
    if (marker) {
      return as(
        BUCKETS.EDITION,
        `One title contains the other and the ISBN's carries "${marker}", so ` +
          `this is the right book in another printing and the stored name is ` +
          `the owner's. Rename the work to the API's title, keeping the ` +
          `owner's on the entry.`
      );
    }
    return as(
      BUCKETS.TITLE_LENGTH,
      `The ${longer} is the other with more of the full name, and the ` +
        `authors ${authors === "shared" ? "agree" : "do not disagree"}, so ` +
        `this is one book under two lengths of its name. Rename the work to ` +
        `the API's title, keeping the owner's on the entry.`
    );
  }

  if (relation === "equal") {
    return as(
      BUCKETS.NEEDS_HUMAN,
      "The two titles now compare equal, so this refusal would not happen " +
        "today — the report is stale or the row has already been repaired. " +
        "Re-run the backfill for this book before doing anything to it."
    );
  }

  if (authors === "shared" && marker) {
    return as(
      BUCKETS.EDITION,
      `The titles have nothing in common but the author is the same and the ` +
        `ISBN's title carries "${marker}", so this is a retitled printing of ` +
        `the stored book. Rename the work to the API's title, keeping the ` +
        `owner's on the entry.`
    );
  }

  if (authors === "shared") {
    return as(
      BUCKETS.NEEDS_HUMAN,
      `Same author, two unrelated titles, both in English. That is a retitled ` +
        `edition ("The Fundamentals of Style" is "Dressing the Man") and a ` +
        `different book by the same author equally well, and nothing here ` +
        `separates them. A person who knows the book decides.`
    );
  }

  return as(
    BUCKETS.NEEDS_HUMAN,
    `The titles have nothing in common and no author is recorded on both ` +
      `sides, so there is no evidence for any of the four. Most likely a ` +
      `different book, but it is not established.`
  );
};

/**
 * One classified book, in the shape the file carries and the repair scripts
 * read back.
 *
 * `apply` is the row a repair script consumes, assembled here so an approved
 * row is applied without retyping — and left `null` for the two buckets that
 * have no repair, so nothing can be pointed at them by accident.
 *
 * **`entryTitle` is deliberately empty on a rename.** `link_entry.js` refuses
 * a `workTitle` without one, which is the guard doing its job: the name a work
 * loses has to be written down on the entry, and the only person who may write
 * it is the one whose row it is. Pre-filling it from the stored title would be
 * a script choosing text people read, which is the line CLAUDE.md draws.
 *
 * `apiRef` is the ref **as the work carries it**, prefix and all, and is not
 * rebuilt from `isbn`. A book's apiRef is prefixed where an identity check's
 * is the bare number, and the prefix is `ISBN__` on most of them and
 * `google__` on the rest; `set_work_ref.js` checks `replacesRef` against what
 * the document actually holds, so a rebuilt `ISBN__<number>` would refuse
 * against a `google__` row — silently, and books-only, which is the shape of
 * mistake that made #313's split come out 162/114.
 *
 * @type {(input: {
 *   work: object, refTitle?: unknown, refSubtitle?: unknown,
 *   refAuthors?: unknown, refLanguage?: unknown, isbn?: unknown,
 *   apiRef?: unknown,
 * }) => object}
 */
const triageRow = ({
  work,
  refTitle,
  refSubtitle,
  refAuthors,
  refLanguage,
  isbn,
  apiRef,
} = {}) => {
  const storedTitle = displayTitle(work);
  const { bucket, reasoning, evidence } = classifyRefusal({
    storedTitle,
    refTitle,
    refSubtitle,
    storedAuthors: work?.authors,
    refAuthors,
    refLanguage,
  });

  return {
    id: String(work?._id ?? ""),
    storedTitle,
    refTitle: refTitle === undefined ? null : String(refTitle),
    // Kept beside the title it belongs to so the file holds everything the
    // call was made on. The evidence block reduces it to the one boolean the
    // decision used, and a reader checking a `subtitle-trap` row — or
    // re-running the classifier over a saved file rather than spending the
    // day's Google Books budget again — needs the text.
    refSubtitle: refSubtitle === undefined ? null : String(refSubtitle),
    isbn: isbn === undefined ? null : String(isbn),
    bucket,
    reasoning,
    evidence,
    apiRef: apiRef === undefined ? null : String(apiRef),
    storedAuthors: Array.isArray(work?.authors) ? work.authors : [],
    refAuthors: Array.isArray(refAuthors) ? refAuthors : [],
    repair: REPAIRS[bucket],
    apply: applyRow(bucket, work, refTitle, apiRef),
    // Filled in by whoever reads the file. `null` is "not looked at yet",
    // `false` is "looked at, not this", `true` is an approval — the same three
    // states ./book_ref_proposal.js uses, so one reader learns one convention.
    approved: null,
  };
};

/**
 * The operation an approved row becomes, or `null` where there is none.
 *
 * A translation gets no operation on purpose: the repair is a *fresh* ISBN,
 * which nothing here knows — `propose_book_refs.js` finds the candidates and a
 * person picks one. Naming the book for that run is all this file can honestly
 * do, and inventing an ISBN to pre-fill would be the exact mistake that put
 * these books here.
 */
const applyRow = (bucket, work, refTitle, apiRef) => {
  const id = String(work?._id ?? "");
  if (bucket === BUCKETS.EDITION || bucket === BUCKETS.TITLE_LENGTH) {
    return {
      script: "link_entry.js",
      op: "retitle",
      type: "books",
      toWork: id,
      workTitle: String(refTitle ?? ""),
      // Typed by hand, for this row, by the person whose row it is. See above.
      entryTitle: "",
      entry: "",
    };
  }
  if (bucket === BUCKETS.DIFFERENT_BOOK) {
    return {
      script: "set_work_ref.js",
      work: id,
      // The ISBN to point at instead, which a person supplies: this file knows
      // the stored one is wrong and nothing about which one is right.
      ref: "",
      // The ref exactly as the document carries it, prefix included. See the
      // note on triageRow: this is never rebuilt from the bare number.
      replacesRef: apiRef ? String(apiRef) : "",
    };
  }
  if (bucket === BUCKETS.TRANSLATION) {
    return { script: "propose_book_refs.js", work: id, searchTitle: displayTitle(work) };
  }
  return null;
};

/**
 * The counts, per bucket, plus the two tallies that are not buckets.
 *
 * `notSearched` is passed in rather than derived, because a book whose lookup
 * failed never became a row: it is the count of questions this run could not
 * ask, and #385 is explicit that it must not be folded into the findings. The
 * same goes for `failures`, which is the 54 the backfill reported — Google
 * Books quota, not frozen works, kept apart by `frozenWorks` in
 * ./metadata_refresh_plan.js and kept apart here.
 * @type {(rows: object[], extra?: { notSearched?: number, failures?: number }) => object}
 */
const summarize = (rows, { notSearched = 0, failures = 0 } = {}) => {
  const counts = Object.fromEntries(Object.values(BUCKETS).map((b) => [b, 0]));
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.bucket in counts) counts[row.bucket] += 1;
  }
  return {
    classified: Array.isArray(rows) ? rows.length : 0,
    buckets: counts,
    notSearched,
    failures,
  };
};

/**
 * The heading each bucket gets in the readable copy, naming the repair so a
 * reader never has to hold the mapping in their head.
 */
const BUCKET_TITLES = {
  [BUCKETS.EDITION]:
    "1. A different edition of the right book — rename the work (link_entry.js)",
  [BUCKETS.TRANSLATION]:
    "2. A translation — wants a fresh English ISBN (propose_book_refs.js)",
  [BUCKETS.DIFFERENT_BOOK]:
    "3. A different book entirely — repoint (set_work_ref.js, replacesRef)",
  [BUCKETS.TITLE_LENGTH]:
    "4. A shorter or longer title for the same thing — rename the work (link_entry.js)",
  [BUCKETS.NEEDS_HUMAN]:
    "5. Needs a human — the evidence does not reach",
  [BUCKETS.SUBTITLE_TRAP]:
    "6. The adapter's subtitle asymmetry — a code fix, not a data repair",
};

/**
 * The readable copy of a triage file.
 *
 * Here rather than in the script for the reason the rest of this file is: it
 * is what a person actually reads before approving a production write, and a
 * renderer that can only be exercised by connecting to the database and
 * spending a Google Books budget is a renderer nobody checks. This way
 * ./book_refusal_triage.test.js reads it with no install, no database and no
 * API key.
 *
 * The counts table carries every bucket including the empty ones, and carries
 * "not searched" and the backfill's failures as rows that are visibly *not*
 * buckets — a reader should not have to know the difference to see it.
 * @type {(file: object, name?: string) => string}
 */
const toMarkdown = (file, name = "the JSON beside this file") => {
  const summary = file?.summary ?? summarize(file?.rows ?? []);
  const rows = Array.isArray(file?.rows) ? file.rows : [];
  const notSearched = Array.isArray(file?.notSearched) ? file.notSearched : [];

  const lines = [
    "# Books the refresh cannot unfreeze (#385)",
    "",
    `Generated ${file?.generatedAt ?? "(unknown)"} from \`${name}\`.`,
    "",
    "**No repair has been applied, and nothing here writes one.** Every row",
    "below is a proposal. Check it against the book, set `approved` in the",
    "JSON, then hand the approved rows to the script each one names. A rename",
    "also needs an `entryTitle` you type yourself: `link_entry.js` refuses a",
    "`workTitle` without one, and that guard is the point — the name a work",
    "loses has to be written down on the entry, by the person whose row it is.",
    "",
    "| bucket | count |",
    "| --- | ---: |",
    ...Object.entries(summary.buckets ?? {}).map(([b, n]) => `| ${b} | ${n} |`),
    `| _not searched — no answer, not a finding_ | ${summary.notSearched ?? 0} |`,
    `| _backfill failures — quota, not refusals_ | ${summary.failures ?? 0} |`,
    "",
  ];

  for (const bucket of Object.values(BUCKETS)) {
    const inBucket = rows.filter((row) => row?.bucket === bucket);
    if (inBucket.length === 0) continue;
    lines.push(`## ${BUCKET_TITLES[bucket]}`, "", `${inBucket.length} book(s).`, "");
    for (const row of inBucket) {
      lines.push(
        `- **${row.storedTitle}** → \`${row.apiRef ?? row.isbn ?? "(no ref)"}\` ` +
          `answers *${row.refTitle}*`,
        `  - work id \`${row.id}\``,
        `  - authors: stored ${nameList(row.storedAuthors)}; ` +
          `the ISBN's ${nameList(row.refAuthors)}`,
        `  - ${row.reasoning}`,
        ""
      );
    }
  }

  if (notSearched.length > 0) {
    lines.push(
      "## Not searched — no answer, and so no finding",
      "",
      "Google Books did not answer for these, so they are **not** classified",
      "and are in none of the buckets above. This is not a verdict about the",
      "book; re-run with `--retry=<this file's JSON>` to ask again.",
      ""
    );
    for (const row of notSearched) {
      lines.push(
        `- **${row.storedTitle}** (work id \`${row.id}\`, ` +
          `\`${row.apiRef ?? row.isbn ?? "(no ref)"}\`) — ${row.notSearchedBecause}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
};

const nameList = (names) =>
  Array.isArray(names) && names.length > 0 ? names.join(", ") : "(none recorded)";

/** The counts as a run prints them, in the same order the file carries. */
const describeSummary = (summary) =>
  [
    `${summary.classified} classified:`,
    ...Object.entries(summary.buckets ?? {}).map(
      ([bucket, n]) => `  ${bucket}: ${n}`
    ),
    `  not searched (no answer, not a finding): ${summary.notSearched}`,
    `  backfill failures (quota, not refusals): ${summary.failures}`,
  ].join("\n");

module.exports = {
  BUCKETS,
  BUCKET_TITLES,
  REPAIRS,
  EDITION_WORDS,
  toMarkdown,
  describeSummary,
  parseRefusal,
  titleRelation,
  isSubtitleTrap,
  glossNaming,
  authorAgreement,
  editionMarker,
  isNonEnglish,
  classifyRefusal,
  triageRow,
  summarize,
};
