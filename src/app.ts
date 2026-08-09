import { Hono } from "hono";
import { Scalar } from "@scalar/hono-api-reference";
import type { LookupDb } from "./db";
import type { ApiLang, DictionaryMeta, PublicLookupItem, PublicSource } from "./types";
import type { EnglishEntry } from "./english-types";
import { dataReleaseUrl } from "./data-release";
import {
  englishLookupEntry,
  japaneseLookupEntry,
  lookupLanguages,
  parseLookupDictionary,
  parseLookupLang,
  type LookupDictionary,
  type LookupEntry
} from "./lookup-contract";
import type { OnDemandDictionary, OnDemandEntry, ResolveRequest } from "./on-demand-dictionary";

type AppOptions = {
  onDemand?: OnDemandDictionary;
  /**
   * Reads the published English entries a query reaches, best first, in one
   * explanation language. Never calls a model.
   */
  englishLookupAll?: (query: string, lang: ApiLang) => EnglishEntry[];
  /**
   * What the English dictionary can truthfully say about itself. Absent when
   * no English data is mounted, which is why `/v1/meta` reports the English
   * dictionary as carrying no languages rather than inventing a list.
   */
  englishMeta?: () => DictionaryMeta;
  enrichmentToken?: string;
  logger?: (event: Record<string, unknown>) => void;
};

export function createApp(
  db: LookupDb,
  options: AppOptions = {}
) {
  const app = new Hono();

  app.onError((error, c) => {
    options.logger?.({
      event: "lookup_failed",
      error: error instanceof Error ? error.message : String(error)
    });
    return c.json({ error: "Lookup is temporarily unavailable" }, 500);
  });

  app.get("/", (c) =>
    c.json({
      name: "Yori Dict",
      description: "Open Japanese and English dictionary lookup backed by independent data releases.",
      health: "/health",
      meta: "/v1/meta",
      lookup: "/v1/lookup?q=食べました&dictionary=ja&lang=zh-tw",
      batchLookup: "/v1/lookup/batch",
      docs: "/doc",
      openapi: "/openapi.yaml",
      dataRelease: dataReleaseUrl
    })
  );

  app.get("/doc", Scalar({ url: "/openapi.yaml", pageTitle: "Yori Dict API Docs" }));

  app.get("/openapi.yaml", async (c) =>
    c.body(await Bun.file("openapi.yaml").text(), 200, {
      "content-type": "application/yaml; charset=utf-8"
    })
  );

  app.get("/health", (c) => c.json({ ok: true }));

  // Metadata is derived, never declared. Each dictionary reports the
  // explanation languages it holds senses in, so a language pair that would
  // return null for every query is not advertised and a downstream generator
  // can skip it before emitting anything. Per ADR-0005 the two dictionaries
  // stay independent and no union of their languages is implied. `sources`
  // credits everything the served data draws on, both dictionaries together,
  // because the attribution obligations a consumer inherits are not per
  // dictionary. The version and tags describe the Japanese release.
  //
  // `languages` and `accepts` answer two different questions, and reporting
  // only the first made the endpoint say less than the API does. `languages`
  // is observed: what senses exist right now. It moves on its own, because an
  // authorized enrichment writes a language the released data did not have —
  // `en`+`ja` appeared this way. `accepts` is the contract, and it is fixed:
  // what a lookup will take and enrichment can fill. A consumer deciding which
  // locales to offer its readers wants `accepts`; one deciding what it can
  // serve today without paying for a model wants `languages`.
  app.get("/v1/meta", (c) => {
    const japanese = db.meta();
    const english = options.englishMeta?.() ?? { languages: [], sources: [] };
    return c.json({
      ...japanese,
      sources: mergeSources(japanese.sources, english.sources),
      dictionaries: {
        ja: { languages: japanese.languages, accepts: lookupLanguages.ja },
        en: { languages: english.languages, accepts: lookupLanguages.en }
      }
    });
  });

  app.get("/v1/lookup", async (c) => {
    const query = c.req.query("q");
    if (!query || query.trim() === "") {
      return c.json({ error: "Missing required query parameter: q" }, 400);
    }

    const dictionary = parseLookupDictionary(c.req.query("dictionary"));
    if (!dictionary) {
      return c.json({ error: "Required query parameter dictionary must be ja or en" }, 400);
    }
    const lang = parseLookupLang(dictionary, c.req.query("lang"));
    if (!lang) {
      return c.json({ error: unsupportedLanguage(dictionary) }, 400);
    }

    const wantsEnrichment = c.req.query("enrich") === "true";
    if (wantsEnrichment && !isAuthorized(c.req.header("authorization"), options.enrichmentToken)) {
      return c.json({ error: "Enrichment requires a valid bearer token" }, 401);
    }
    const traceId = c.req.header("x-yori-request-id") ?? crypto.randomUUID();
    const lemma = c.req.query("lemma")?.trim();
    const enriched = wantsEnrichment && options.onDemand
      ? await options.onDemand.resolve(resolveRequest(query, dictionary, lang, {
          lemma,
          reading: c.req.query("reading"),
          sentence: c.req.query("context")
        }, undefined, traceId))
      : null;
    const entry = readEntry(db, options, dictionary, lang, query, lemma, enriched);
    logLookup(options, traceId, dictionary, lang, query, wantsEnrichment, entry);
    return c.json(entry);
  });

  app.post("/v1/lookup/batch", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }

    if (!isBatchBody(body)) {
      return c.json({ error: "Request body must include a non-empty queries array" }, 400);
    }

    const dictionary = parseLookupDictionary(body.dictionary);
    if (!dictionary) {
      return c.json({ error: "Request body field dictionary must be ja or en" }, 400);
    }
    const lang = parseLookupLang(dictionary, body.lang);
    if (!lang) {
      return c.json({ error: unsupportedLanguage(dictionary) }, 400);
    }
    if (body.enrich && !isAuthorized(c.req.header("authorization"), options.enrichmentToken)) {
      return c.json({ error: "Enrichment requires a valid bearer token" }, 401);
    }
    const traceId = c.req.header("x-yori-request-id") ?? crypto.randomUUID();
    // One word must not decide the fate of the other ninety-nine. A provider
    // that fails for a single query is reported as a miss for that query, and
    // the batch keeps every entry it did resolve. The word is not lost: the
    // failure is logged, and the next enriched lookup of it attempts again.
    //
    // A batch where *every* query failed is the other thing entirely — an
    // expired token, a provider outage, a misconfigured key — and answering it
    // with a full set of misses would let a consumer publish an empty
    // dictionary and believe it. That one fails loudly.
    const settled = await Promise.allSettled(body.queries.map(async (candidate) => {
      const request = typeof candidate === "string"
        ? resolveRequest(candidate, dictionary, lang, {}, "bulk", traceId)
        : resolveRequest(candidate.query, dictionary, lang, {
            lemma: candidate.lemma,
            reading: candidate.reading,
            sentence: candidate.context
          }, "bulk", traceId);
      try {
        const enriched = body.enrich && options.onDemand
          ? await options.onDemand.resolve(request)
          : null;
        const entry = readEntry(
          db,
          options,
          dictionary,
          lang,
          request.query,
          request.context?.lemma,
          enriched
        );
        logLookup(options, traceId, dictionary, lang, request.query, body.enrich === true, entry);
        return entry;
      } catch (error) {
        logLookupFailure(options, traceId, dictionary, lang, request.query, error);
        throw error;
      }
    }));
    if (settled.every((result) => result.status === "rejected")) {
      return c.json({ error: "Lookup is temporarily unavailable" }, 500);
    }
    const entries = settled.map((result) => (result.status === "fulfilled" ? result.value : null));
    return c.json({ entries });
  });

  return app;
}

/**
 * Reads one entry for the requested dictionary and explanation language.
 * Enriched content is preferred when the owner asked for it; otherwise the
 * released store answers. Either way the result is projected into the
 * requested language and becomes null when that language has no content.
 */
function readEntry(
  db: LookupDb,
  options: AppOptions,
  dictionary: LookupDictionary,
  lang: ApiLang,
  query: string,
  lemma: string | undefined,
  enriched: OnDemandEntry | null
): LookupEntry | null {
  if (dictionary === "en") {
    // Authored content answers for the word it was authored for and has no
    // siblings to offer, so enrichment yields one entry and no alternatives.
    const authored = asEnglishEntry(enriched);
    if (authored) return englishLookupEntry(authored, lang);
    const entries = options.englishLookupAll?.(query, lang) ?? [];
    const resolved = entries.length > 0 || !lemma || lemma === query
      ? entries
      : options.englishLookupAll?.(lemma, lang) ?? [];
    return withAlternatives(resolved.map((entry) => englishLookupEntry(entry, lang)));
  }
  const authored = asJapaneseEntry(enriched);
  if (authored) return japaneseLookupEntry(authored, lang);
  const { item, alternatives } = db.lookup(query, lang);
  return withAlternatives([item, ...alternatives].map((match) => match && japaneseLookupEntry(match, lang)));
}

/**
 * The first entry that projects into the requested language, carrying the rest
 * behind it. A match that owns no sense in this language is dropped rather than
 * offered as an empty alternative, and the field is left off entirely when
 * nothing survives it, so the common single-entry query pays nothing.
 */
function withAlternatives(matches: Array<LookupEntry | null>): LookupEntry | null {
  const [entry, ...rest] = matches.filter((match): match is LookupEntry => match !== null);
  if (!entry) return null;
  return rest.length > 0 ? { ...entry, alternatives: rest } : entry;
}

function asEnglishEntry(entry: OnDemandEntry | null): EnglishEntry | null {
  return entry && "dictionary" in entry ? entry : null;
}

function asJapaneseEntry(entry: OnDemandEntry | null): PublicLookupItem | null {
  return entry && !("dictionary" in entry) ? entry : null;
}

type BatchCandidate = string | { query: string; lemma?: string; reading?: string; context?: string };

function isBatchBody(body: unknown): body is {
  queries: BatchCandidate[];
  dictionary?: unknown;
  lang?: unknown;
  enrich?: boolean;
} {
  if (!body || typeof body !== "object") return false;
  const candidate = body as { queries?: unknown; enrich?: unknown };
  return (
    Array.isArray(candidate.queries) &&
    candidate.queries.length > 0 &&
    candidate.queries.every(isBatchCandidate) &&
    (candidate.enrich === undefined || typeof candidate.enrich === "boolean")
  );
}

function isBatchCandidate(value: unknown): value is BatchCandidate {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object") return false;
  const candidate = value as { query?: unknown; lemma?: unknown; reading?: unknown; context?: unknown };
  return typeof candidate.query === "string"
    && candidate.query.trim().length > 0
    && [candidate.lemma, candidate.reading, candidate.context].every(
      (field) => field === undefined || typeof field === "string"
    );
}

function resolveRequest(
  query: string,
  targetDictionary: LookupDictionary,
  lang: ApiLang,
  context: { lemma?: string; reading?: string; sentence?: string } = {},
  mode?: ResolveRequest["mode"],
  traceId?: string
): ResolveRequest {
  const compact = Object.fromEntries(
    Object.entries(context).filter(([, value]) => typeof value === "string" && value.trim().length > 0)
  ) as NonNullable<ResolveRequest["context"]>;
  return {
    query,
    targetDictionary,
    lang,
    ...(traceId ? { traceId } : {}),
    ...(mode ? { mode } : {}),
    ...(Object.keys(compact).length > 0 ? { context: compact } : {})
  };
}

/**
 * One credit per source across both dictionaries, in the order they were
 * given. A source both dictionaries draw on is credited once; a reader
 * satisfying an obligation does it per source, not per dictionary.
 */
function mergeSources(...lists: PublicSource[][]): PublicSource[] {
  const credits = new Map<string, PublicSource>();
  for (const source of lists.flat()) {
    if (!credits.has(source.name)) credits.set(source.name, source);
  }
  return [...credits.values()];
}

function unsupportedLanguage(dictionary: LookupDictionary): string {
  return `Required explanation language lang is missing or unsupported for the ${dictionary} dictionary`;
}

function isAuthorized(header: string | undefined, token: string | undefined): boolean {
  return Boolean(token && header === `Bearer ${token}`);
}

/**
 * Records the one query that failed, so a miss caused by a provider is
 * separable in the log from a word the dictionary genuinely cannot explain.
 * The response cannot carry that distinction without a shape every consumer
 * would have to learn, and the operator is who acts on it.
 */
function logLookupFailure(
  options: AppOptions,
  traceId: string | undefined,
  dictionary: LookupDictionary,
  lang: ApiLang,
  query: string,
  error: unknown
): void {
  options.logger?.({
    event: "lookup_failed",
    traceId,
    dictionary,
    lang,
    query,
    error: error instanceof Error ? error.message : String(error)
  });
}

function logLookup(
  options: AppOptions,
  traceId: string | undefined,
  dictionary: LookupDictionary,
  lang: ApiLang,
  query: string,
  enrichmentRequested: boolean,
  entry: LookupEntry | null
): void {
  options.logger?.({
    event: "dictionary_lookup",
    traceId,
    dictionary,
    lang,
    query,
    enrichmentRequested,
    outcome: entry ? "resolved" : "missing",
    entryId: entry?.id ?? null
  });
}
