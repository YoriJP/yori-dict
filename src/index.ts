import { createApp } from "./app";
import { openLookupDb } from "./db";
import { openExampleOverlay } from "./example-overlay";
import { createEnrichmentService, defaultModelCall } from "./example-enrichment";

const dbPath = process.env.YORI_DB_PATH ?? "data/yori.sqlite";
const db = openLookupDb(dbPath);
const overlay = openExampleOverlay(process.env.YORI_EXAMPLE_OVERLAY_PATH ?? "data/example-overlay.sqlite");
const enrichment = createEnrichmentService({
  overlay,
  modelCall: defaultModelCall,
  concurrency: Number(process.env.YORI_ENRICHMENT_CONCURRENCY ?? "4"),
  timeoutMs: Number(process.env.YORI_MODEL_TIMEOUT_MS ?? "15000")
});
const app = createApp(db, {
  enrichment,
  enrichmentToken: process.env.YORI_ENRICHMENT_TOKEN
});

export default app;
