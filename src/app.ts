import { Hono } from "hono";
import { Scalar } from "@scalar/hono-api-reference";
import { parseApiLang } from "./lang";
import type { LookupDb } from "./db";
import type { PublicLookupItem } from "./types";
import type { EnglishEntry } from "./english-types";
import { dataReleaseUrl } from "./data-release";
import { publicEntryForLanguage } from "./public-entry";
import type {
  EnglishOnDemandDictionary,
  OnDemandDictionary,
  ResolveRequest,
  TargetDictionary
} from "./on-demand-dictionary";

type AppOptions = {
  onDemand?: OnDemandDictionary;
  englishLookup?: (query: string) => EnglishEntry | null;
  englishOnDemand?: EnglishOnDemandDictionary;
  enrichmentToken?: string;
  logger?: (event: Record<string, unknown>) => void;
};

export function createApp(
  db: LookupDb,
  options: AppOptions = {}
) {
  const app = new Hono();

  app.get("/", (c) =>
    c.json({
      name: "Yori Dict",
      description: "Open Japanese and English dictionary lookup backed by independent data releases.",
      health: "/health",
      meta: "/v1/meta",
      lookup: "/v1/lookup?q=食べました&lang=zh-tw",
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

    const lang = parseApiLang(c.req.query("lang") ?? null);
    const dictionary = parseDictionary(c.req.query("dictionary"));
    if (!dictionary) return c.json({ error: "Unsupported dictionary" }, 400);
    const wantsEnrichment = c.req.query("enrich") === "true";
    if (wantsEnrichment && !isAuthorized(c.req.header("authorization"), options.enrichmentToken)) {
      return c.json({ error: "Enrichment requires a valid bearer token" }, 401);
    }
    const resolver = dictionary === "en" ? options.englishOnDemand : options.onDemand;
    const traceId = c.req.header("x-yori-request-id") ?? crypto.randomUUID();
    const enriched = wantsEnrichment && resolver
      ? await resolver.resolve(resolveRequest(query, dictionary, {
          lemma: c.req.query("lemma"),
          reading: c.req.query("reading"),
          sentence: c.req.query("context")
        }, undefined, traceId)).catch(() => null)
      : null;
    if (dictionary === "en") {
      const lemma = c.req.query("lemma")?.trim();
      const item = enriched
        ?? options.englishLookup?.(query)
        ?? (lemma && lemma !== query ? options.englishLookup?.(lemma) : null)
        ?? null;
      logLookup(options, traceId, dictionary, query, wantsEnrichment, item);
      return c.json({ item });
    }
    const japaneseEntry = enriched as PublicLookupItem | null;
    const item = japaneseEntry ? publicEntryForLanguage(japaneseEntry, lang ?? "en") : db.lookup(query, lang).item;
    logLookup(options, traceId, dictionary, query, wantsEnrichment, item);
    return c.json({ item });
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

    const lang = parseApiLang(body.lang ?? null);
    const dictionary = body.dictionary ?? "ja";
    if (body.enrich && !isAuthorized(c.req.header("authorization"), options.enrichmentToken)) {
      return c.json({ error: "Enrichment requires a valid bearer token" }, 401);
    }
    const traceId = c.req.header("x-yori-request-id") ?? crypto.randomUUID();
    const response = {
      results: await Promise.all(body.queries.map(async (candidate) => {
        const request = typeof candidate === "string"
          ? resolveRequest(candidate, dictionary, {}, "bulk", traceId)
          : resolveRequest(candidate.query, dictionary, {
              lemma: candidate.lemma,
              reading: candidate.reading,
              sentence: candidate.context
            }, "bulk", traceId);
        const resolver = dictionary === "en" ? options.englishOnDemand : options.onDemand;
        const enriched = body.enrich && resolver
          ? await resolver.resolve(request).catch(() => null)
          : null;
        if (dictionary === "en") {
          const lemma = request.context?.lemma;
          const item = enriched
            ?? options.englishLookup?.(request.query)
            ?? (lemma && lemma !== request.query ? options.englishLookup?.(lemma) : null)
            ?? null;
          logLookup(options, traceId, dictionary, request.query, body.enrich === true, item);
          return { input: request.query, item };
        }
        const resolved = enriched as PublicLookupItem | null ?? db.lookup(request.query, lang).item;
        logLookup(options, traceId, dictionary, request.query, body.enrich === true, resolved);
        return {
          input: request.query,
          item: resolved?.source === "generated" ? publicEntryForLanguage(resolved, lang ?? "en") : resolved
        };
      }))
    };
    return c.json(response);
  });

  return app;
}

type BatchCandidate = string | { query: string; lemma?: string; reading?: string; context?: string };

function isBatchBody(body: unknown): body is {
  queries: BatchCandidate[];
  dictionary?: TargetDictionary;
  lang?: string;
  enrich?: boolean;
} {
  if (!body || typeof body !== "object") return false;
  const candidate = body as { queries?: unknown; dictionary?: unknown; lang?: unknown; enrich?: unknown };
  return (
    Array.isArray(candidate.queries) &&
    candidate.queries.length > 0 &&
    candidate.queries.every(isBatchCandidate) &&
    (candidate.dictionary === undefined || candidate.dictionary === "ja" || candidate.dictionary === "en") &&
    (candidate.lang === undefined || typeof candidate.lang === "string") &&
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
  targetDictionary: TargetDictionary,
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
    ...(traceId ? { traceId } : {}),
    ...(mode ? { mode } : {}),
    ...(Object.keys(compact).length > 0 ? { context: compact } : {})
  };
}

function parseDictionary(value: string | undefined): TargetDictionary | null {
  if (value === undefined || value === "ja") return "ja";
  return value === "en" ? "en" : null;
}

function isAuthorized(header: string | undefined, token: string | undefined): boolean {
  return Boolean(token && header === `Bearer ${token}`);
}

function logLookup(
  options: AppOptions,
  traceId: string | undefined,
  dictionary: TargetDictionary,
  query: string,
  enrichmentRequested: boolean,
  item: PublicLookupItem | EnglishEntry | null
): void {
  options.logger?.({
    event: "dictionary_lookup",
    traceId,
    dictionary,
    query,
    enrichmentRequested,
    outcome: item ? "resolved" : "missing",
    entryId: item?.id ?? null
  });
}
