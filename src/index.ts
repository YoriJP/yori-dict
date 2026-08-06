import { createApp } from "./app";
import { openLookupDb } from "./db";
import { createOverlayLookupDb, openEnrichmentRepository } from "./enrichment-repository";
import { createOpenRouterModelGateway } from "./model-gateway";
import { createOnDemandDictionary } from "./on-demand-dictionary";
import { openSourceEvidenceIndex } from "./source-index";

const dbPath = process.env.YORI_DB_PATH ?? "data/yori.sqlite";
const releasedDb = openLookupDb(dbPath);
const sourceIndex = await openSourceEvidenceIndex(
  (process.env.YORI_JA_SOURCE_EVIDENCE_PATHS ?? "").split(",").map((path) => path.trim()).filter(Boolean)
);
const repository = openEnrichmentRepository(
  process.env.YORI_ENRICHMENT_OVERLAY_PATH ?? process.env.YORI_EXAMPLE_OVERLAY_PATH ?? "data/example-overlay.sqlite",
  releasedDb,
  sourceIndex.lookup
);
const onDemand = createOnDemandDictionary({
  repository,
  modelGateway: createOpenRouterModelGateway({ apiKey: process.env.OPENROUTER_API_KEY }),
  concurrency: Number(process.env.YORI_ENRICHMENT_CONCURRENCY ?? "4"),
  timeoutMs: Number(process.env.YORI_MODEL_TIMEOUT_MS ?? "15000")
});
const app = createApp(createOverlayLookupDb(releasedDb, repository), {
  onDemand,
  enrichmentToken: process.env.YORI_ENRICHMENT_TOKEN
});

export default app;
