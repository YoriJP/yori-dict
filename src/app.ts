import { Hono } from "hono";
import { Scalar } from "@scalar/hono-api-reference";
import { parseApiLang } from "./lang";
import type { LookupDb } from "./db";
import type { ApiLang, BatchLookupResponse, PublicLookupItem } from "./types";
import { dataReleaseUrl } from "./data-release";
import type { OnDemandDictionary, ResolveRequest } from "./on-demand-dictionary";

export function createApp(
  db: LookupDb,
  options: { onDemand?: OnDemandDictionary; enrichmentToken?: string } = {}
) {
  const app = new Hono();

  app.get("/", (c) =>
    c.json({
      name: "Yori Dict",
      description: "Open Japanese dictionary API and SQLite database with multilingual lookup support.",
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
    const wantsEnrichment = c.req.query("enrich") === "true";
    if (wantsEnrichment && !isAuthorized(c.req.header("authorization"), options.enrichmentToken)) {
      return c.json({ error: "Enrichment requires a valid bearer token" }, 401);
    }
    const enriched = wantsEnrichment && options.onDemand
      ? await options.onDemand.resolve(resolveRequest(query, {
          lemma: c.req.query("lemma"),
          reading: c.req.query("reading"),
          sentence: c.req.query("context")
        })).catch(() => null)
      : null;
    return c.json({ item: enriched ? entryForLanguage(enriched, lang ?? "en") : db.lookup(query, lang).item });
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
    if (body.enrich && !isAuthorized(c.req.header("authorization"), options.enrichmentToken)) {
      return c.json({ error: "Enrichment requires a valid bearer token" }, 401);
    }
    const response: BatchLookupResponse = {
      results: await Promise.all(body.queries.map(async (candidate) => {
        const request = typeof candidate === "string"
          ? resolveRequest(candidate, {}, "bulk")
          : resolveRequest(candidate.query, {
              lemma: candidate.lemma,
              reading: candidate.reading,
              sentence: candidate.context
            }, "bulk");
        const enriched = body.enrich && options.onDemand
          ? await options.onDemand.resolve(request).catch(() => null)
          : null;
        const resolved = enriched ?? db.lookup(request.query, lang).item;
        return {
          input: request.query,
          item: resolved?.source === "generated" ? entryForLanguage(resolved, lang ?? "en") : resolved
        };
      }))
    };
    return c.json(response);
  });

  return app;
}

function entryForLanguage(entry: PublicLookupItem, lang: ApiLang): PublicLookupItem {
  if (entry.source !== "generated") return entry;
  return {
    ...entry,
    senses: entry.senses.flatMap((sense) => {
      const glosses = sense.glosses
        .filter((gloss) => !gloss.lang || gloss.lang === lang)
        .map(({ lang: _lang, ...gloss }) => gloss);
      return glosses.length > 0 ? [{ ...sense, glosses }] : [];
    })
  };
}

type BatchCandidate = string | { query: string; lemma?: string; reading?: string; context?: string };

function isBatchBody(body: unknown): body is { queries: BatchCandidate[]; lang?: string; enrich?: boolean } {
  if (!body || typeof body !== "object") return false;
  const candidate = body as { queries?: unknown; lang?: unknown; enrich?: unknown };
  return (
    Array.isArray(candidate.queries) &&
    candidate.queries.length > 0 &&
    candidate.queries.every(isBatchCandidate) &&
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
  context: { lemma?: string; reading?: string; sentence?: string } = {},
  mode?: ResolveRequest["mode"]
): ResolveRequest {
  const compact = Object.fromEntries(
    Object.entries(context).filter(([, value]) => typeof value === "string" && value.trim().length > 0)
  ) as NonNullable<ResolveRequest["context"]>;
  return {
    query,
    targetDictionary: "ja",
    ...(mode ? { mode } : {}),
    ...(Object.keys(compact).length > 0 ? { context: compact } : {})
  };
}

function isAuthorized(header: string | undefined, token: string | undefined): boolean {
  return Boolean(token && header === `Bearer ${token}`);
}
