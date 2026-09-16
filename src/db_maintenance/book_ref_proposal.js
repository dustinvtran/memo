/**
 * @file Which English editions are worth offering for a book filed under a
 * translated edition's ISBN, and what a repoint writes once a person has
 * picked one.
 *
 * #344. The backfill refuses a book whose ISBN names a different title, and
 * for most of these the ISBN names the right book in the wrong language — `The
 * Little Prince` under `Le Petit Prince`, `Animal Farm` under `La ferme des
 * animaux`. The owner does not have the French editions, so the stored
 * `englishTranslatedTitle` is right and the `apiRefs` entry is wrong, and the
 * fix is to repoint the ref at an English edition rather than to relax the
 * guard.
 *
 * **The population is every refusal, not only the translations.** It is
 * derived by running the guard, so a plain misfiling comes with them — the
 * production run found `A Christmas Carol` filed under `281241572X`, which is
 * *Les Aventures d'Olivier Twist*, a French edition of a different Dickens
 * novel. Nothing below has to tell the two apart: both are a book whose ref
 * names something else, both are fixed by finding the English edition of the
 * title that is stored, and the filters that make that safe are the same
 * filters either way.
 *
 * Pure and dependency-free like its neighbours, for the reason
 * ./work_metadata_merge.js is: this is the half that decides what gets written
 * to production, and scripts/propose_book_refs.js is the half that does the
 * network calls and the writes. ./book_ref_proposal.test.js covers it with no
 * install, no database and no API key.
 *
 * ## Why nothing here picks a candidate
 *
 * Google Books will answer a title search with English editions carrying
 * ISBN-13s for every title sampled, and its first hit is wrong often enough
 * that taking it would be #290 arriving by a new route. From the sample on
 * #344:
 *
 *   - `The Little Prince` leads with a 116-page print-on-demand volume from
 *     "E-Kitap Projesi & Cheapest Books"; the Houghton Mifflin Harcourt
 *     edition is second.
 *   - `Brave New World`'s second hit is `Brave New World and Brave New World
 *     Revisited`, which is a different book.
 *   - `Animal Farm`'s top three are a publisher-less 56-page edition, a
 *     Chinese-published one, and one of a single page.
 *
 * Two of those are bad *editions* and one is a bad *work*, and they want
 * different answers. A bad edition is what the later stages of
 * `candidateRejection` are for: hard filters that a real published book passes
 * and a stub record does not. A bad work is what `titlesAgree` is for, and it
 * is the one that matters, because a wrong edition is a wrong page count and a
 * wrong work is unrecoverable without a snapshot.
 *
 * What survives is ranked and offered, two or three at a time, to a person.
 * `rankCandidates` orders them; it does not choose, and a book whose
 * candidates are all rejected is reported as having none rather than given the
 * best of a bad set. The whole point of the issue is that these books got
 * here because somebody once took a search result without reading it.
 *
 * ## The author check, which is not decoration
 *
 * `titlesAgree` is deliberately loose — ./work_collections.js says so at
 * length — and the looseness it documents as safe is safe because it compares
 * one stored work against the answer its *own id* gave. Here it compares a
 * stored work against a search result, which is the one use that file warns
 * off: `The Stranger (Animorphs, #7)` and Camus' `The Stranger` reduce to the
 * same string, and a search for the latter will return the former.
 *
 * So the title is not allowed to be the only evidence. A candidate whose
 * authors are known, and share none with the stored book's, is refused. 326 of
 * the 328 books with a gap carry an author, so this has teeth on essentially
 * all of them, and it is what stands between a repoint and the exact collision
 * #290 and #308 spent two rounds cleaning up.
 */
const {
  parseApiRef,
  findApiRef,
  comparableTitle,
  comparableTitlesOf,
  displayTitle,
  titlesAgree,
  isEmptyValue,
} = require("./work_collections");

/**
 * Below this, a Google Books volume is a stub rather than a book.
 *
 * Measured against the library rather than guessed: the shortest page count
 * stored on any of the 650 books is 11, and the next two are 15 and 21. Ten is
 * under all of them and over the 0s and 1s that the sample's rejects carry, so
 * it cannot refuse a book of the kind this collection actually holds. A real
 * short book — a picture book, a single Haruhi volume — is left for a person
 * to look at, which is what every number in the proposal file is there for.
 */
const MIN_PAGE_COUNT = 10;

/**
 * What a repoint takes off the work along with the wrong ISBN, and why each
 * one is certainly the *edition's* rather than possibly the work's.
 *
 * That is the whole test, and it is narrower than "everything the wrong ref
 * wrote". #290's repair could be wider because it had evidence per
 * value — a value copied onto two documents in a collision group is one
 * retrieve's output — and there is no such evidence here: these books have no
 * partner to compare against. So the line is drawn on the field rather than on
 * the value, and only where the field admits no reading under which the stored
 * value could still be right after the ref changes.
 *
 * Clearing is `$unset` for scripts/clear_unusable_work_fields.js's reason: a
 * missing field is what `isEmptyValue` recognises, so the next `--missing-only`
 * backfill fills it from the new ref. That matters most for `duration`, which
 * is on books' `fillOnlyFields` (#333) and so is the one field a refresh would
 * *never* replace — leaving a French page count under an English ISBN would
 * leave it there for good.
 *
 * What is deliberately not here: `releaseYear`, `publishers`, `genres`,
 * `authors` and both titles.
 *
 *   - `releaseYear` is fill-only for #333's reason, and #333's measurement is
 *     the argument for keeping it: six of seven year changes a 60-book dry run
 *     proposed moved a public-domain work forward to a modern reprint,
 *     `Robinson Crusoe` 1719 to 2019 among them. A stored year here is far
 *     more often the work's first publication than the French printing's, and
 *     clearing it would invite the next run to replace the first with the
 *     second. That is #333's bug, re-created by the script that was meant to
 *     be careful.
 *   - `publishers` is the field this looks least right on, and it is kept
 *     because a publisher can be the work's and not only the printing's —
 *     Gallimard really did publish `Le Petit Prince` first. Mixed evidence is
 *     not the standard this list is drawn to.
 *   - `genres` and `authors` describe the work in any language.
 *   - The titles are the evidence the ref was wrong, and ./work_metadata_merge.js
 *     keeps them out of every write for that reason.
 */
const EDITION_FIELDS = {
  duration:
    "a page count belongs to a printing and to nothing else — there is no " +
    "sense in which a work is 96 pages long — so a French edition's count is " +
    "wrong under an English ISBN. It is also `fillOnly` for books since #333, " +
    "which means a refresh will never replace it: cleared it is refilled by " +
    "the next run, left alone it is wrong for ever",
  imageUrl:
    "the cover is served out of the volume the wrong ISBN named, so it is the " +
    "French jacket whatever it shows, and it is the first thing a reader sees",
  metadataUpdatedDate:
    "bookkeeping: it records when an adapter last had something to say about " +
    "this work, and that adapter was answering about another edition. " +
    "Unsetting it also sorts the book to the head of the refresh queue, which " +
    "is where a book whose ref has just changed belongs",
};

/**
 * The `externalUrls` entries a repoint drops. Narrowed rather than unset, the
 * same way `apiRefs` is: every book's links today are a single `Google Play`
 * entry written by the books adapter, and a second kind added later would have
 * nothing to do with the ISBN coming off.
 *
 * They are dropped for `imageUrl`'s reason, one level up. The url carries the
 * volume id and the volume's own title —
 * `books.google.com/books/about/Le_Petit_Prince.html?id=…` — so it opens the
 * French edition's page under an English book's name.
 */
const EDITION_URL_NAMES = ["Google Play"];

/** ISBN-13 as Google Books writes it in `industryIdentifiers`. */
const ISBN_13 = /^[0-9]{13}$/;

/**
 * One Google Books volume, reduced to what a proposal shows and a filter
 * reads.
 *
 * `fullTitle` joins the subtitle the way `google_search.js` does, because
 * Google files `Sapiens` and `A Brief History of Humankind` separately and
 * either spelling may be the one that matches what is stored.
 *
 * The ISBN-13 specifically, and not `isbnOf`'s "first identifier whose type
 * contains ISBN": that helper takes an ISBN-10 when one is listed first, and
 * an ISBN-10 is what several of these books are already filed under. A repoint
 * is a chance to land on the identifier every catalogue agrees about.
 *
 * @type {(volumeInfo: any) => {
 *   isbn: string | undefined, title: string, subtitle: string | undefined,
 *   fullTitle: string, publisher: string | undefined,
 *   pageCount: number | undefined, year: number | undefined,
 *   language: string | undefined, authors: string[], link: string | undefined,
 * }}
 */
const toCandidate = (volumeInfo) => {
  const title = String(volumeInfo?.title ?? "");
  const subtitle = volumeInfo?.subtitle || undefined;

  return {
    isbn: (volumeInfo?.industryIdentifiers ?? []).find(
      (identifier) => identifier?.type === "ISBN_13"
    )?.identifier,
    title,
    subtitle,
    fullTitle: [title, subtitle].filter((part) => part).join(": "),
    publisher: volumeInfo?.publisher || undefined,
    pageCount:
      typeof volumeInfo?.pageCount === "number" ? volumeInfo.pageCount : undefined,
    year:
      parseInt(String(volumeInfo?.publishedDate ?? "").slice(0, 4)) || undefined,
    language: volumeInfo?.language,
    authors: (volumeInfo?.authors ?? []).filter(
      (author) => typeof author === "string" && author !== ""
    ),
    link: volumeInfo?.canonicalVolumeLink,
  };
};

/**
 * Why this volume must not be offered for this book, or undefined.
 *
 * The order is the order a reader of the rejections wants them in: what the
 * volume *is* first (an identifier, a language), then whether it is the same
 * work at all, then whether it is a real printing, then whether the ISBN is
 * free. The title test sits in the middle rather than first because the two
 * before it are the cheap ways of not being a candidate, and the ones after it
 * are only worth asking about the right book.
 *
 * That order is also the answer, which is why a rejection carries the `stage`
 * it fell at rather than only a sentence. A book that comes back with no
 * candidate wants a reason a person can act on, and "eleven volumes had no
 * ISBN and twenty-seven were other books" and "one volume was this book from a
 * publisher Google does not name" are different situations: the first says the
 * edition is not in Google Books, the second says it is and the filter is the
 * thing standing in the way. Sorting the rejections by stage puts the nearest
 * misses at the top of that list.
 *
 * `owners` maps an ISBN to the ids of the books already filed under it — see
 * `refOwners`. A candidate whose ISBN another book holds is refused outright
 * rather than offered with a warning: two works under one identity ref is the
 * state #290 found and #308 finished cleaning up, and a script that can create
 * one has no business being run against production. The book's own id is
 * excluded, so re-proposing for a book that already carries the ISBN is not a
 * collision with itself.
 *
 * @type {(work: any, candidate: any, context?: { owners?: Map<string, string[]> }) => { stage: number, label: string, reason: string } | undefined}
 */
const candidateRejection = (work, candidate, { owners } = {}) => {
  if (!candidate.isbn || !ISBN_13.test(candidate.isbn)) {
    return rejected(0, "no ISBN-13", "there would be nothing to file it under");
  }
  if (candidate.language !== "en") {
    return rejected(
      1,
      "not in English",
      `language is ${candidate.language ?? "unstated"}, not en`
    );
  }

  const agrees = titlesAgree(work, {
    englishTranslatedTitle: candidate.title,
    originalTitle: candidate.fullTitle,
  });
  if (agrees !== true) {
    return rejected(
      2,
      "another book",
      `titled "${candidate.fullTitle}", which is not "${displayTitle(work)}"`
    );
  }

  const authorClash = authorConflict(work, candidate);
  if (authorClash) return rejected(3, "another author", authorClash);

  if (!candidate.publisher) {
    return rejected(
      4,
      "no publisher",
      "no publisher — the mark of a print-on-demand or scraped record"
    );
  }
  if (candidate.pageCount === undefined || candidate.pageCount < MIN_PAGE_COUNT) {
    return rejected(
      5,
      "too few pages",
      `${candidate.pageCount ?? "no"} page(s), under the ${MIN_PAGE_COUNT} a real printing has`
    );
  }

  const held = (owners?.get(candidate.isbn) ?? []).filter(
    (id) => id !== String(work._id)
  );
  if (held.length > 0) {
    return rejected(
      6,
      "already taken",
      `${held.join(", ")} is filed under it — repointing here would create a shared ref`
    );
  }

  return undefined;
};

const rejected = (stage, label, reason) => ({ stage, label, reason });

/**
 * Whether the candidate is demonstrably somebody else's book, or undefined
 * when there is nothing to compare.
 *
 * Equality or containment after the same reduction `comparableTitle` uses, so
 * that `Antoine de Saint-Exupéry` and `Antoine de Saint Exupery` are one
 * person and `George Orwell` matches `George Orwell (Author)`. Any stored
 * author matching any of the candidate's is enough: a translated edition often
 * lists the translator beside the author, and a stored list often carries an
 * editor.
 */
const authorConflict = (work, candidate) => {
  const ours = comparableNames(work.authors);
  const theirs = comparableNames(candidate.authors);
  if (ours.length === 0 || theirs.length === 0) return undefined;
  if (ours.some((a) => theirs.some((b) => a === b || a.includes(b) || b.includes(a)))) {
    return undefined;
  }
  return (
    `by ${candidate.authors.join(", ")}, and this book is by ` +
    `${work.authors.join(", ")} — the titles agreeing is not enough on its own`
  );
};

const comparableNames = (names) =>
  (Array.isArray(names) ? names : [])
    .map(comparableTitle)
    .filter((name) => name !== "");

/**
 * The surviving candidates, best first. This orders; it does not choose.
 *
 * Three signals, in the order they are trusted, and Google's own ranking to
 * break the ties they leave:
 *
 *   1. **The author is confirmed** rather than merely not contradicted. A book
 *      with no stored author, or a volume Google lists none for, cannot clear
 *      this and sorts behind one that can.
 *   2. **The whole of the volume's title is the stored title**, with nothing
 *      left over. A plain `Animal Farm` is a better offer than `Animal Farm:
 *      A Fairy Story, With Study Guide`, and both pass the filter because
 *      `titlesAgree` is offered the title with and without its subtitle. The
 *      comparison is against `fullTitle` rather than `title` for that reason:
 *      the bare titles are identical in that pair, and the subtitle is the
 *      whole of the difference. A book stored *with* its subtitle — `Sapiens:
 *      A Brief History of Humankind` — ranks the matching volume first by the
 *      same rule.
 *   3. **The page count is in the stored count's neighbourhood**, where there
 *      is a stored count. Two printings of one book are not the same length
 *      and are not an order of magnitude apart; a translation runs perhaps a
 *      third longer. This is a tiebreaker and not a filter for exactly that
 *      reason — and the stored count is the French edition's, which is a
 *      ballpark and not an authority. It is also the value the repoint then
 *      clears, so it is used here and believed nowhere else.
 *
 * @type {(work: any, candidates: any[]) => any[]}
 */
const rankCandidates = (work, candidates) =>
  candidates
    .map((candidate, index) => ({
      candidate,
      key: [
        authorConfirmed(work, candidate) ? 0 : 1,
        comparableTitlesOf(work).includes(comparableTitle(candidate.fullTitle))
          ? 0
          : 1,
        pageDistance(work, candidate),
        index,
      ],
    }))
    .sort((a, b) => compareKeys(a.key, b.key))
    .map(({ candidate }) => candidate);

const authorConfirmed = (work, candidate) =>
  comparableNames(work.authors).length > 0 &&
  comparableNames(candidate.authors).length > 0 &&
  authorConflict(work, candidate) === undefined;

/** 0 within a quarter of the stored count, 1 within a half, 2 beyond — and 0
 * for a book with no stored count, which is no signal rather than a bad one. */
const pageDistance = (work, candidate) => {
  const stored = work.duration;
  if (typeof stored !== "number" || stored <= 0) return 0;
  if (candidate.pageCount === undefined) return 2;
  const ratio = Math.abs(candidate.pageCount - stored) / stored;
  return ratio <= 0.25 ? 0 : ratio <= 0.5 ? 1 : 2;
};

const compareKeys = (a, b) => {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
};

/**
 * One book's proposal: what it is filed under now, and the editions worth
 * offering instead.
 *
 * Deduplicated by ISBN before filtering, because the two queries a search runs
 * return the same edition twice — `google_search.js` does the same for the
 * same reason. The rejections are kept and returned: "no candidate survived"
 * is a finding a person has to be able to read the reason for, and on this
 * data it is usually one reason repeated.
 *
 * @type {(
 *   work: any,
 *   fresh: any,
 *   volumeInfos: any[],
 *   context?: { owners?: Map<string, string[]>, limit?: number },
 * ) => object}
 */
const proposeForWork = (work, fresh, volumeInfos, { owners, limit = 3 } = {}) => {
  const seen = new Set();
  const accepted = [];
  const misses = [];

  for (const volumeInfo of volumeInfos) {
    const candidate = toCandidate(volumeInfo);
    if (candidate.isbn && seen.has(candidate.isbn)) continue;
    if (candidate.isbn) seen.add(candidate.isbn);

    const rejection = candidateRejection(work, candidate, { owners });
    if (rejection) misses.push({ ...candidate, ...rejection });
    else accepted.push(candidate);
  }

  // Nearest miss first: the stages are in the order a candidate passes them,
  // so the volumes that got furthest are the ones worth a person's eye.
  misses.sort((a, b) => b.stage - a.stage);

  const currentRef = findApiRef(work.apiRefs, "ISBN");

  return {
    id: String(work._id),
    title: displayTitle(work),
    authors: Array.isArray(work.authors) ? work.authors : [],
    storedYear: work.releaseYear,
    storedPageCount: work.duration,
    currentRef,
    // What the wrong ISBN actually names, which is the evidence that it is
    // wrong and the thing a person checks the proposal against.
    currentRefNames: fresh ? displayTitle(fresh) : undefined,
    considered: volumeInfos.length,
    candidates: rankCandidates(work, accepted).slice(0, limit),
    rejected: misses,
    // Filled in by whoever reads the file. `null` is "not looked at yet";
    // `false` is "looked at, none of these"; an ISBN is an approval. An
    // `approvedBecause` beside it is free text saying why, which the Markdown
    // prints under the table and nothing else reads — a decision this file
    // exists to make deliberately is worth a sentence of its own.
    approved: null,
  };
};

/**
 * Which of two attempts at the same book to keep, when a rate-limited run has
 * been retried: the one that was actually answered, and on a tie the one that
 * saw more of Google Books.
 *
 * This exists because a retry can be throttled too, and replacing a partial
 * answer with an empty one would lose candidates the first run did find. It is
 * the same rule the rest of this file runs on — an unanswered question
 * replaces nothing — applied to the file rather than to the database.
 *
 * `considered` rather than the number of candidates, so a retry that reached
 * more volumes and rejected every one still wins: that is a better answer to
 * "is there an English edition of this", even though it offers no more to
 * approve.
 *
 * @type {(previous: any, retried: any) => any}
 */
const betterAttempt = (previous, retried) => {
  const failures = (attempt) => attempt?.searchFailures ?? 0;
  if (failures(retried) !== failures(previous)) {
    return failures(retried) < failures(previous) ? retried : previous;
  }
  return (retried?.considered ?? 0) >= (previous?.considered ?? 0)
    ? retried
    : previous;
};

/**
 * Every ISBN the collection has a book filed under, and which books.
 *
 * Built over both identity prefixes rather than over `ISBN__` alone: the
 * descriptor accepts `google__` for the same identifier, so an ISBN held under
 * that name is just as much a collision. Nothing in the books collection
 * carries one today, which is precisely why reading the descriptor rather than
 * the data is what keeps that true.
 *
 * @type {(collection: any, works: any[]) => Map<string, string[]>}
 */
const refOwners = (collection, works) => {
  const owners = new Map();
  const prefixes = collection?.identityPrefixes ?? [];

  for (const work of works) {
    for (const apiRef of Array.isArray(work.apiRefs) ? work.apiRefs : []) {
      const parsed = parseApiRef(apiRef);
      if (!parsed || !prefixes.includes(parsed.name)) continue;
      const ids = owners.get(parsed.ref) ?? [];
      if (!ids.includes(String(work._id))) ids.push(String(work._id));
      owners.set(parsed.ref, ids);
    }
  }

  return owners;
};

/**
 * What to write for the approvals in a proposal file, given what the API says
 * about each approved ISBN right now.
 *
 * `blocked` means what it means in ./orphan_review_plan.js: a condition
 * under which planning at all would be a mistake, and the caller stops rather
 * than writing a subset.
 *
 * **The approved ISBN is verified against the API again here**, and against
 * the collection as it stands, rather than trusted because it was in the file.
 * #290's repair re-ran its identity checks immediately before it
 * wrote for the same reason: a proposal file is a saved answer, it may be
 * days old, and the one thing that must not happen is a write that files two
 * books under one ISBN because a second proposal was applied in between. An
 * approval that no longer verifies is skipped and reported; it is not a
 * failure of the run.
 *
 * `verifications` maps an approved ISBN to `{ fresh }` or `{ error }` — what
 * the adapter said when the script asked. Keeping the calls outside is what
 * lets every rule below be tested without one.
 *
 * @typedef {{
 *   _id: any, title: string, oldRef: string | undefined, newRef: string,
 *   apiRefs: string[], removedRefs: string[],
 *   externalUrls: object[], removedUrls: object[],
 *   unset: Array<{ field: string, value: unknown }>,
 * }} Repoint
 * @type {(
 *   collection: any,
 *   works: any[],
 *   proposals: any[],
 *   verifications: Map<string, { fresh?: any, error?: string }>,
 * ) => {
 *   blocked: string | undefined,
 *   repoints: Repoint[],
 *   skipped: Array<{ title: string, isbn: string, reason: string }>,
 *   unapproved: number,
 *   totals: { approved: number, repointed: number, values: number },
 * }}
 */
const planRepoint = (collection, works, proposals, verifications) => {
  const blocked = refuse(collection, works, proposals);
  if (blocked) return { ...emptyPlan(), blocked };

  const byId = new Map(works.map((work) => [String(work._id), work]));
  const owners = refOwners(collection, works);
  const plan = emptyPlan();

  // Two approvals naming one ISBN would pass every check below individually
  // and produce the collision between them, because neither is in `owners`
  // until it is written. Counted over the file rather than over the database.
  const approvedCounts = new Map();
  for (const proposal of proposals) {
    const isbn = approvalOf(proposal);
    if (isbn) approvedCounts.set(isbn, (approvedCounts.get(isbn) ?? 0) + 1);
  }

  for (const proposal of proposals) {
    const isbn = approvalOf(proposal);
    if (!isbn) {
      plan.unapproved += 1;
      continue;
    }
    plan.totals.approved += 1;

    const skip = (reason) =>
      plan.skipped.push({ title: proposal.title, isbn, reason });

    if (!ISBN_13.test(isbn)) {
      skip("not an ISBN-13");
      continue;
    }
    if (approvedCounts.get(isbn) > 1) {
      skip("approved for more than one book in this file, which is a shared ref");
      continue;
    }

    const work = byId.get(String(proposal.id));
    if (!work) {
      skip(`${proposal.id} is not in ${collection.works} any more`);
      continue;
    }

    const held = (owners.get(isbn) ?? []).filter(
      (id) => id !== String(work._id)
    );
    if (held.length > 0) {
      skip(`${held.join(", ")} is already filed under it`);
      continue;
    }

    const verification = verifications.get(isbn);
    if (!verification || verification.error) {
      skip(
        `Google Books would not confirm it (${verification?.error ?? "not checked"})`
      );
      continue;
    }
    if (titlesAgree(work, verification.fresh) !== true) {
      skip(
        `it names "${displayTitle(verification.fresh)}", not ` +
          `"${displayTitle(work)}"`
      );
      continue;
    }

    const repoint = repointOf(collection, work, isbn);

    // Nothing to swap, so nothing to clear either: the edition's values on a
    // book already filed under this ISBN came from this ISBN. Skipped rather
    // than written, so that a proposal file applied twice is not a second
    // round of `$unset`s and a bulkWrite that modifies fewer documents than
    // the plan names.
    if (repoint.oldRef === isbn) {
      skip("already filed under it");
      continue;
    }

    plan.repoints.push(repoint);
    plan.totals.repointed += 1;
    plan.totals.values += repoint.unset.length + repoint.removedUrls.length;
  }

  return plan;
};

module.exports = {
  MIN_PAGE_COUNT,
  EDITION_FIELDS,
  EDITION_URL_NAMES,
  ISBN_13,
  toCandidate,
  candidateRejection,
  rankCandidates,
  proposeForWork,
  betterAttempt,
  refOwners,
  planRepoint,
};

///////////////////////////////////////////////////////////////////////////////

/** Why planning at all would be a mistake, or undefined. */
const refuse = (collection, works, proposals) => {
  if (
    !Array.isArray(collection?.identityPrefixes) ||
    typeof collection?.retrievePrefix !== "string" ||
    typeof collection?.works !== "string"
  ) {
    return (
      "the collection descriptor must carry identityPrefixes, retrievePrefix " +
      "and works — they are what says which ids name the book"
    );
  }
  if (collection.type !== "books") {
    return (
      `${collection.type} is not books, and a translated edition under its ` +
      `own ISBN is a shape only books have`
    );
  }
  if (!Array.isArray(works)) return "works must be an array";
  if (!Array.isArray(proposals)) {
    return "the proposal file must hold an array of proposals";
  }
  return undefined;
};

/** The ISBN a person approved for this proposal, or undefined. */
const approvalOf = (proposal) =>
  typeof proposal?.approved === "string" && proposal.approved.trim() !== ""
    ? proposal.approved.trim()
    : undefined;

/**
 * One book's write: the new ref in, the old identity refs out, the edition's
 * values with them.
 *
 * `apiRefs` is narrowed and never unset, the way #290's repair
 * narrowed it: every ref naming the ISBN this book is losing comes off under
 * any prefix that names a book, the new one goes on, and anything else the
 * document carries is left exactly where it is. An unset-and-set would be
 * shorter and would throw away a ref nothing here has an opinion about.
 */
const repointOf = (collection, work, isbn) => {
  const apiRefs = Array.isArray(work.apiRefs) ? work.apiRefs : [];
  const oldRef = findApiRef(apiRefs, collection.retrievePrefix);

  const removedRefs = apiRefs.filter((apiRef) => {
    const parsed = parseApiRef(apiRef);
    return (
      parsed &&
      collection.identityPrefixes.includes(parsed.name) &&
      (parsed.ref === oldRef || parsed.ref === isbn)
    );
  });

  const kept = apiRefs.filter((apiRef) => !removedRefs.includes(apiRef));

  const urls = Array.isArray(work.externalUrls) ? work.externalUrls : [];
  const removedUrls = urls.filter((url) =>
    EDITION_URL_NAMES.includes(url?.name)
  );

  return {
    _id: work._id,
    title: displayTitle(work),
    oldRef,
    newRef: isbn,
    removedRefs,
    apiRefs: [...kept, `${collection.retrievePrefix}__${isbn}`],
    removedUrls,
    externalUrls: urls.filter((url) => !removedUrls.includes(url)),
    unset: Object.keys(EDITION_FIELDS)
      .filter((field) => !isEmptyValue(work[field]))
      .map((field) => ({ field, value: work[field] })),
  };
};

const emptyPlan = () => ({
  blocked: undefined,
  repoints: [],
  skipped: [],
  unapproved: 0,
  totals: { approved: 0, repointed: 0, values: 0 },
});
