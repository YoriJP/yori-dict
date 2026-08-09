import { normalizeEnglishLookupTerm } from "./normalize";

/**
 * Regular English inflection stripping, in one place because two callers must
 * never disagree about it: the lookup that resolves an inflected surface to
 * its lemma, and the authoring guard that stops a model minting one as a
 * canonical entry.
 *
 * Import is deliberately not a caller. A source that says which of its own
 * senses are word forms is telling us; stripping its headwords would be
 * guessing over the top of that, and both callers here only ever act on a
 * surface the lexicon has already failed to answer.
 *
 * It follows WordNet's Morphy approach, and the reason a rule set this small
 * is enough is that it does not try to be correct in isolation. It generates
 * candidate lemmas cheaply and the lexicon rejects the wrong ones: `bus` does
 * not strip to `bu` because `bu` is not a word, and no rule has to know that.
 * Growing the rule table to avoid wrong guesses would be solving a problem the
 * validator already solves.
 *
 * Irregular forms are deliberately absent. `geese` resolves only if some
 * source already records it as a form of `goose`; nothing here invents the
 * mapping.
 */

type Rule = { suffix: string; replacement: string };

/**
 * Regular inflectional substitutions only. `-ly` is word formation rather than
 * inflection, so there are no adverb rules: `quickly` is its own lexeme and
 * resolving it to `quick` would lose a real entry.
 *
 * Longer suffixes come first so that `wishes` is tried as `wish` before it is
 * tried as `wishe`.
 */
const rules: readonly Rule[] = [
  // Plurals whose stem is recoverable from the suffix alone. There is no
  // `-shes`, `-zes` or `-ses` rule: the bare `-es` below already reaches
  // `wish`, `quiz` and `bus`, so they only ever fired first with a worse
  // answer — `-ses` alone took `corpses` to `corps`, `doses` to `dos` and
  // `vases` to `vas`.
  { suffix: "ches", replacement: "ch" },
  { suffix: "xes", replacement: "x" },
  { suffix: "ies", replacement: "y" },
  { suffix: "men", replacement: "man" },
  // Third person and the bare plural.
  { suffix: "es", replacement: "e" },
  // The `-f`/`-fe` plurals come after `-es`, because `-ves` is a closed set of
  // nouns while `-ves` as a third-person verb form is open. Trying them first
  // cost `believes` its verb and gave `saves` to `safe`, and bought nothing:
  // `leaves`, `knives` and `wives` are recorded as forms of their own lemmas,
  // so a real lexicon answers them before any rule runs.
  { suffix: "ves", replacement: "f" },
  { suffix: "ves", replacement: "fe" },
  { suffix: "es", replacement: "" },
  { suffix: "s", replacement: "" },
  // Past and progressive. The e-restoring form comes first so `welcomed`
  // is tried as `welcome` before `welcom`.
  { suffix: "ed", replacement: "e" },
  { suffix: "ed", replacement: "" },
  // `-ied` restores the `y` the suffix consumed, and comes last of the three
  // for the same reason `-ves` follows `-es`: the y-stems are the smaller
  // class. Trying it first would take `died` to `dy` and `skied` to `sky`,
  // while `studied` still reaches `study` here because neither `studie` nor
  // `studi` is a word.
  { suffix: "ied", replacement: "y" },
  { suffix: "ing", replacement: "e" },
  { suffix: "ing", replacement: "" },
  // Comparative and superlative. Here the y-restoring rules come *first*,
  // the opposite of `-ied`, because the competitor is wrong more often than
  // it is right: `-er` with the `e` restored turns `crappier` into the fish
  // `crappie` and `junkier` into `junkie`, where `-ier` gives the adjectives
  // those surfaces actually compare. Nothing is lost by trying it first,
  // because `tier`, `cashier` and `terrier` reach no `-y` word at all.
  { suffix: "iest", replacement: "y" },
  { suffix: "ier", replacement: "y" },
  { suffix: "est", replacement: "e" },
  { suffix: "est", replacement: "" },
  { suffix: "er", replacement: "e" },
  { suffix: "er", replacement: "" }
];

/**
 * Every lemma the regular rules can produce from `surface`, in rule order and
 * without duplicates. These are candidates, not answers: a caller must put
 * each one to the lexicon before treating it as a word.
 */
export function englishLemmaCandidates(surface: string): string[] {
  const term = normalizeEnglishLookupTerm(surface);
  const candidates = new Set<string>();
  const add = (candidate: string) => {
    if (candidate !== term && candidate.length > 0) candidates.add(candidate);
  };
  for (const { suffix, replacement } of rules) {
    // A rule that consumes the whole surface produces no lemma, only noise.
    if (!term.endsWith(suffix) || term.length <= suffix.length) continue;
    const stem = term.slice(0, term.length - suffix.length);
    add(`${stem}${replacement}`);
    // A stem ending in a doubled consonant may have doubled it to take the
    // suffix: `running` to `run`, `stopped` to `stop`, `bigger` to `big`.
    // Undoubling is a guess like any other, and the lexicon settles it.
    if (replacement === "" && isDoubledConsonant(stem)) add(stem.slice(0, -1));
  }
  return [...candidates];
}

/**
 * The consonants English doubles before a vowel-initial suffix. `c` is absent
 * because it takes a `k` instead of doubling, and `h`, `j`, `q`, `w`, `x` and
 * `y` do not double at all.
 */
const doubling = /[bdfgklmnprstvz]/;

function isDoubledConsonant(stem: string): boolean {
  const last = stem.at(-1);
  return (
    stem.length > 2
    && last !== undefined
    && last === stem.at(-2)
    && doubling.test(last)
  );
}

/**
 * The lemma `surface` inflects from, or null when it is already a lemma or no
 * candidate is a word.
 *
 * `exists` is the lexicon, and it is what makes the rule set sufficient. The
 * surface is checked first: a word that is itself an entry is never resolved
 * away, so `bus` stays `bus` even though it looks like a plural, and `news`
 * does not become `new`.
 *
 * A surface that two rules both resolve takes the first in rule order, which
 * is a real choice rather than a right answer — `bases` reaches `bas` before
 * `base`. Disambiguating would need the sentence, and this is word-level
 * lookup help, not sentence parsing. Rule order is therefore where a genuine
 * ambiguity is settled, and it is ordered by which reading is the open class.
 */
export function resolveEnglishLemma(
  surface: string,
  exists: (candidate: string) => boolean
): string | null {
  const term = normalizeEnglishLookupTerm(surface);
  if (!term || exists(term)) return null;
  return englishLemmaCandidates(term).find(exists) ?? null;
}
