import { expect, test } from "bun:test";
import { englishLemmaCandidates, resolveEnglishLemma } from "../src/english-strip";

/** A lexicon of lemmas, standing in for the stored English lookup terms. */
function lexicon(...terms: string[]): (candidate: string) => boolean {
  const known = new Set(terms);
  return (candidate) => known.has(candidate);
}

test("the lexicon rejects wrong guesses so the rule set can stay small", () => {
  // Every rule that matches fires; being wrong is cheap because the validator
  // is what decides. `bus` produces `bu`, and `bu` is simply not a word.
  expect(englishLemmaCandidates("bus")).toContain("bu");
  expect(resolveEnglishLemma("bus", lexicon("bus", "bu"))).toBeNull();
  expect(resolveEnglishLemma("bus", lexicon("busy"))).toBeNull();
});

test("a regular inflected surface resolves to the lemma the lexicon carries", () => {
  const cases: Array<[string, string]> = [
    ["robots", "robot"],
    ["wants", "want"],
    ["welcomed", "welcome"],
    ["walked", "walk"],
    ["running", "run"],
    ["studies", "study"],
    ["boxes", "box"],
    ["wishes", "wish"],
    ["buses", "bus"],
    ["believes", "believe"],
    ["leaves", "leaf"],
    ["knives", "knife"],
    ["policemen", "policeman"],
    ["larger", "large"],
    ["largest", "large"],
    ["quicker", "quick"]
  ];
  for (const [surface, lemma] of cases) {
    expect(resolveEnglishLemma(surface, lexicon(lemma))).toBe(lemma);
  }
});

test("a -ied surface restores the y the suffix consumed", () => {
  // A lemma whose source never indexed its inflections has only the rules to
  // reach it, and `studie` and `studi` are not words.
  expect(resolveEnglishLemma("studied", lexicon("study"))).toBe("study");
  expect(resolveEnglishLemma("partied", lexicon("party"))).toBe("party");
  expect(resolveEnglishLemma("guarantied", lexicon("guaranty"))).toBe("guaranty");
  // The rule comes last of the three, so an -ie verb keeps its own past form.
  // Trying `-ied` first would take these to `dy` and `sky`.
  expect(resolveEnglishLemma("died", lexicon("die", "dy"))).toBe("die");
  expect(resolveEnglishLemma("skied", lexicon("ski", "sky"))).toBe("ski");
  expect(resolveEnglishLemma("lied", lexicon("lie", "ly"))).toBe("lie");
});

test("a -ier or -iest surface restores the y before trying to restore an e", () => {
  // The opposite order to `-ied`, and for a measured reason: here the `-er`
  // competitor lands on a real but unrelated word more often than on the
  // right one. `crappie` is a fish and `junkie` is a person.
  expect(resolveEnglishLemma("crappier", lexicon("crappy", "crappie"))).toBe("crappy");
  expect(resolveEnglishLemma("junkiest", lexicon("junky", "junkie"))).toBe("junky");
  expect(resolveEnglishLemma("pointier", lexicon("pointy"))).toBe("pointy");
  expect(resolveEnglishLemma("stickiest", lexicon("sticky"))).toBe("sticky");
  // A noun that merely ends in -ier reaches no -y word, so the lexicon still
  // settles it and the eager order costs nothing: `cashy` is not a word.
  expect(resolveEnglishLemma("cashier", lexicon("cash"))).toBeNull();
  expect(resolveEnglishLemma("soldier", lexicon("sold"))).toBeNull();
});

test("a -ves surface prefers the verb, because the -f nouns are a closed set", () => {
  // Both readings are reachable, so rule order decides, and it decides for the
  // open class. The closed one loses nothing in practice: a real lexicon
  // records `leaves` and `knives` as forms of `leaf` and `knife`, so it
  // answers them before any rule runs.
  expect(resolveEnglishLemma("believes", lexicon("believe", "belief"))).toBe("believe");
  expect(resolveEnglishLemma("saves", lexicon("save", "safe"))).toBe("save");
  expect(resolveEnglishLemma("serves", lexicon("serve", "serf"))).toBe("serve");
  expect(resolveEnglishLemma("leaves", lexicon("leaves", "leaf", "leave"))).toBeNull();
});

test("a word that is itself an entry is never resolved away", () => {
  // `news` looks like a plural and `bus` looks like one too. Checking the
  // surface first is what stops a real entry being answered with another.
  expect(resolveEnglishLemma("news", lexicon("news", "new"))).toBeNull();
  expect(resolveEnglishLemma("bus", lexicon("bus", "bu"))).toBeNull();
  expect(resolveEnglishLemma("robot", lexicon("robot"))).toBeNull();
});

test("irregular forms are left alone rather than guessed at", () => {
  // No exception list, so these resolve only if a source records the surface.
  expect(resolveEnglishLemma("children", lexicon("child"))).toBeNull();
  expect(resolveEnglishLemma("geese", lexicon("goose"))).toBeNull();
  expect(resolveEnglishLemma("went", lexicon("go"))).toBeNull();
});

test("-ly is word formation, not inflection, so an adverb keeps its own entry", () => {
  expect(resolveEnglishLemma("quickly", lexicon("quick"))).toBeNull();
  expect(englishLemmaCandidates("quickly")).not.toContain("quick");
});

test("a candidate is never the surface itself and never empty", () => {
  for (const surface of ["s", "es", "ed", "ing", "er", "est", "men", "robots", "running"]) {
    const candidates = englishLemmaCandidates(surface);
    expect(candidates).not.toContain(surface);
    expect(candidates).not.toContain("");
  }
  // A rule that would consume the whole surface leaves no stem to keep.
  for (const surface of ["s", "ing", "est", "men"]) {
    expect(englishLemmaCandidates(surface)).toEqual([]);
  }
});

test("a doubled consonant is undoubled, because doubling is regular", () => {
  for (const [surface, lemma] of [["running", "run"], ["stopped", "stop"], ["bigger", "big"]] as const) {
    expect(resolveEnglishLemma(surface, lexicon(lemma))).toBe(lemma);
  }
  // Undoubling is a guess like any other: a genuine double stays when the
  // lexicon says so.
  expect(resolveEnglishLemma("spelled", lexicon("spell"))).toBe("spell");
  expect(resolveEnglishLemma("dressed", lexicon("dress"))).toBe("dress");
});

test("candidates are deduplicated and keep rule order", () => {
  const candidates = englishLemmaCandidates("bases");
  expect(candidates).toEqual([...new Set(candidates)]);
  // `ses` is tried before the bare `es` and `s`, so `base` beats `bas`.
  expect(candidates.indexOf("bas")).toBeLessThan(candidates.indexOf("base"));
  expect(resolveEnglishLemma("bases", lexicon("base", "bas"))).toBe("bas");
});
