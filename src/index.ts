import { createApp } from "./app";
import { openLookupDb } from "./db";
import { openEnrichmentRepository } from "./enrichment-repository";
import { openEnglishEnrichmentRepository } from "./english-enrichment-repository";
import { createOpenRouterModelGateway } from "./model-gateway";
import {
  createEnglishOnDemandDictionary,
  createJapaneseOnDemandDictionary,
  createModelCallLimiter,
  createOnDemandDictionary,
  enrichmentConcurrency,
  modelTimeoutMs
} from "./on-demand-dictionary";
import { openSourceEvidenceIndex } from "./source-index";

const dbPath = process.env.YORI_DB_PATH ?? "data/yori.sqlite";
const logger = (event: Record<string, unknown>) => console.info(JSON.stringify(event));
const modelGateway = createOpenRouterModelGateway({ apiKey: process.env.OPENROUTER_API_KEY });
const modelLimiter = createModelCallLimiter(enrichmentConcurrency);
const releasedDb = openLookupDb(dbPath);
const sourceIndex = await openSourceEvidenceIndex(
  (process.env.YORI_JA_SOURCE_EVIDENCE_PATHS ?? "").split(",").map((path) => path.trim()).filter(Boolean)
);
const repository = openEnrichmentRepository(
  dbPath,
  releasedDb,
  sourceIndex.lookup
);
const japaneseOnDemand = createJapaneseOnDemandDictionary({
  repository,
  modelGateway,
  limiter: modelLimiter,
  reviewPasses: 2,
  timeoutMs: modelTimeoutMs,
  logger
});
const englishRepository = openEnglishEnrichmentRepository(dbPath);
const englishOnDemand = createEnglishOnDemandDictionary({
  repository: englishRepository,
  modelGateway,
  limiter: modelLimiter,
  reviewPasses: 2,
  timeoutMs: modelTimeoutMs,
  logger
});
const onDemand = createOnDemandDictionary({ japanese: japaneseOnDemand, english: englishOnDemand });
const app = createApp(releasedDb, {
  onDemand,
  englishLookupAll: (query, lang) => englishRepository.findAll(query, lang),
  englishMeta: () => englishRepository.meta(),
  logger,
  enrichmentToken: process.env.YORI_ENRICHMENT_TOKEN
});

export default app;
