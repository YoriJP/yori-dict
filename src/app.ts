import { Hono } from "hono";
import { parseApiLang } from "./lang";
import type { LookupDb } from "./db";

const maxBatchSize = 100;

export function createApp(db: LookupDb) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/v1/meta", (c) => c.json(db.meta()));

  app.get("/v1/lookup", (c) => {
    const query = c.req.query("q");
    if (!query || query.trim() === "") {
      return c.json({ error: "Missing required query parameter: q" }, 400);
    }

    const lang = parseApiLang(c.req.query("lang") ?? null);
    return c.json(db.lookup(query, lang));
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
    return c.json({
      results: body.queries.map((query) => db.lookup(query, lang))
    });
  });

  return app;
}

function isBatchBody(body: unknown): body is { queries: string[]; lang?: string } {
  if (!body || typeof body !== "object") return false;
  const candidate = body as { queries?: unknown; lang?: unknown };
  return (
    Array.isArray(candidate.queries) &&
    candidate.queries.every((query) => typeof query === "string") &&
    (candidate.lang === undefined || typeof candidate.lang === "string")
  );
}
