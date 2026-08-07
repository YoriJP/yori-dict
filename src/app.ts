import { Hono } from "hono";
import { Scalar } from "@scalar/hono-api-reference";
import type { LookupDb } from "./db";
import type { ApiLang, PublicLookupItem } from "./types";
import type { EnglishEntry } from "./english-types";
import { dataReleaseUrl } from "./data-release";
import {
  englishLookupEntry,
  japaneseLookupEntry,
  parseLookupDictionary,
  parseLookupLang,
  type LookupDictionary,
  type LookupEntry
} from "./lookup-contract";
import type { OnDemandDictionary, OnDemandEntry, ResolveRequest } from "./on-demand-dictionary";

type AppOptions = {
  onDemand?: OnDemandDictionary;
  englishLookup?: (query: string) => EnglishEntry | null;
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

  app.get("/v1/meta", (c) => c.json(db.meta()));

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
    const entries = await Promise.all(body.queries.map(async (candidate) => {
      const request = typeof candidate === "string"
        ? resolveRequest(candidate, dictionary, lang, {}, "bulk", traceId)
        : resolveRequest(candidate.query, dictionary, lang, {
            lemma: candidate.lemma,
            reading: candidate.reading,
            sentence: candidate.context
          }, "bulk", traceId);
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
    }));
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
    const entry = asEnglishEntry(enriched)
      ?? options.englishLookup?.(query)
      ?? (lemma && lemma !== query ? options.englishLookup?.(lemma) : null)
      ?? null;
    return entry ? englishLookupEntry(entry, lang) : null;
  }
  const item = asJapaneseEntry(enriched) ?? db.lookup(query, lang).item;
  return item ? japaneseLookupEntry(item, lang) : null;
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

function unsupportedLanguage(dictionary: LookupDictionary): string {
  return `Required explanation language lang is missing or unsupported for the ${dictionary} dictionary`;
}

function isAuthorized(header: string | undefined, token: string | undefined): boolean {
  return Boolean(token && header === `Bearer ${token}`);
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
