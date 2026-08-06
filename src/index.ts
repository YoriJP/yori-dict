import { createApp } from "./app";
import { existsSync } from "node:fs";
import { openLookupDb } from "./db";
import { createOverlayLookupDb, openEnrichmentRepository } from "./enrichment-repository";
import { openEnglishEnrichmentRepository } from "./english-enrichment-repository";
import { createOpenRouterModelGateway } from "./model-gateway";
import { createEnglishOnDemandDictionary, createOnDemandDictionary } from "./on-demand-dictionary";
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
const defaultEnglishReleasePath = "releases/english/yori-english-2026.08.1.sqlite";
const configuredEnglishReleasePath = process.env.YORI_ENGLISH_DB_PATH ?? defaultEnglishReleasePath;
const englishReleasePath = existsSync(configuredEnglishReleasePath)
  ? configuredEnglishReleasePath
  : undefined;
const englishRepository = englishReleasePath
  ? openEnglishEnrichmentRepository(
      process.env.YORI_ENGLISH_ENRICHMENT_OVERLAY_PATH ?? "data/english-overlay.sqlite",
      englishReleasePath
    )
  : undefined;
const englishOnDemand = englishRepository
  ? createEnglishOnDemandDictionary({
      repository: englishRepository,
      modelGateway: createOpenRouterModelGateway({ apiKey: process.env.OPENROUTER_API_KEY }),
      concurrency: Number(process.env.YORI_ENRICHMENT_CONCURRENCY ?? "4"),
      timeoutMs: Number(process.env.YORI_MODEL_TIMEOUT_MS ?? "15000")
    })
  : undefined;
const app = createApp(createOverlayLookupDb(releasedDb, repository), {
  onDemand,
  englishLookup: englishRepository
    ? (query) => englishRepository.findOverlay(query) ?? englishRepository.findReleased(query)
    : undefined,
  englishOnDemand,
  logger: (event) => console.info(JSON.stringify(event)),
  enrichmentToken: process.env.YORI_ENRICHMENT_TOKEN
});

export default app;
