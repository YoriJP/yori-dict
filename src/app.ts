import { Hono } from "hono";
import { Scalar } from "@scalar/hono-api-reference";
import { parseApiLang } from "./lang";
import type { LookupDb } from "./db";
import type { BatchLookupResponse } from "./types";
import { dataReleaseUrl } from "./data-release";
import { applyOverlay } from "./example-overlay";
import type { EnrichmentService } from "./example-enrichment";

const maxBatchSize = 100;

export function createApp(
  db: LookupDb,
  options: { enrichment?: EnrichmentService; enrichmentToken?: string } = {}
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
    if (wantsEnrichment && options.enrichment) {
      const sourceItem = db.lookup(query, "en").item;
      if (sourceItem) await options.enrichment.enrich(sourceItem).catch(() => undefined);
    }
    const response = db.lookup(query, lang);
    return c.json({
      item: options.enrichment ? applyOverlay(response.item, options.enrichment.overlay) : response.item
    });
  });

  app.post("/v1/lookup/batch", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }

    if (!isBatchBody(body)) {
      return c.json({ error: "Request body must be { queries: string[], lang?: string }" }, 400);
    }

    if (body.queries.length > maxBatchSize) {
      return c.json({ error: `Batch size must be ${maxBatchSize} or less` }, 400);
    }

    const lang = parseApiLang(body.lang ?? null);
    if (body.enrich && !isAuthorized(c.req.header("authorization"), options.enrichmentToken)) {
      return c.json({ error: "Enrichment requires a valid bearer token" }, 401);
    }
    if (body.enrich && options.enrichment) {
      const sourceItems = body.queries.flatMap((query) => {
        const item = db.lookup(query, "en").item;
        return item ? [item] : [];
      });
      await options.enrichment.enrichMany(sourceItems).catch(() => undefined);
    }
    const response: BatchLookupResponse = {
      results: body.queries.map((query) => {
        const item = db.lookup(query, lang).item;
        return {
          input: query,
          item: options.enrichment ? applyOverlay(item, options.enrichment.overlay) : item
        };
      })
    };
    return c.json(response);
  });

  return app;
}

function isBatchBody(body: unknown): body is { queries: string[]; lang?: string; enrich?: boolean } {
  if (!body || typeof body !== "object") return false;
  const candidate = body as { queries?: unknown; lang?: unknown; enrich?: unknown };
  return (
    Array.isArray(candidate.queries) &&
    candidate.queries.every((query) => typeof query === "string") &&
    (candidate.lang === undefined || typeof candidate.lang === "string") &&
    (candidate.enrich === undefined || typeof candidate.enrich === "boolean")
  );
}

function isAuthorized(header: string | undefined, token: string | undefined): boolean {
  return Boolean(token && header === `Bearer ${token}`);
}
