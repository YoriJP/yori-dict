import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEnglishEnrichmentRepository } from "../src/english-enrichment-repository";
import { buildEnglishRelease, buildEnglishReleaseFromProduction, openEnglishDictionary } from "../src/english-release";
import { importEnglishRelease, migrateProductionDatabase } from "../src/production-database";
import type { AttemptRecord } from "../src/on-demand-dictionary";
import type { EnglishEntry, EnglishExample, EnglishSourceRecord } from "../src/english-types";

test("English source and accepted enrichment share the canonical production database", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-production-"));
  const path = join(root, "yori.sqlite");
  await Bun.$`bun run scripts/import-jmdict.ts --input fixtures/jmdict-sample.json --out ${path}`.quiet();
  migrateProductionDatabase(path);
  const source = sourceRecord();
  const release = await buildEnglishRelease([source], {
    outputDirectory: join(root, "release"), version: "test", createdAt: "2026-08-06T00:00:00.000Z"
  });
  expect(importEnglishRelease(path, release.sqlite)).toBe(true);
  expect(importEnglishRelease(path, release.sqlite)).toBe(false);

  const first = openEnglishEnrichmentRepository(path);
  const entry = generatedEntry();
  const example: EnglishExample = { text: "She leads the team.", source: "generated", reviewStatus: "checked" };
  const attempt = attemptRecord();

  expect(first.find("bank")?.headword).toBe("bank");
  expect(first.findSources("bank")).toEqual([source]);
  first.saveEntry(entry);
  first.saveExample(entry.senses[0].id, example);
  first.recordAttempt(attempt);
  first.saveTerminalOutcome("request:en:nope", "skipped");
  first.close();

  const nextRelease = await buildEnglishRelease([source, sourceRecord("lead")], {
    outputDirectory: join(root, "next-release"), version: "test-2", createdAt: "2026-08-07T00:00:00.000Z"
  });
  expect(importEnglishRelease(path, nextRelease.sqlite)).toBe(true);

  const reopened = openEnglishEnrichmentRepository(path);
  expect(reopened.find("bank")?.headword).toBe("bank");
  const refreshedLead = reopened.find("lead")!;
  expect(refreshedLead.sources.map(({ sourceEntryId }) => sourceEntryId)).toEqual(["lead"]);
  expect(refreshedLead.senses.map(({ definition }) => definition)).toEqual([
    "an element used to connect an electrical circuit",
    "to guide"
  ]);
  expect(refreshedLead.senses[1]).toMatchObject({ provenance: "generated", examples: [example] });
  expect(reopened.acceptedEntries()).toEqual([refreshedLead]);
  expect(reopened.attemptRecords()).toEqual([attempt]);
  expect(reopened.terminalOutcome("request:en:nope")).toBe("skipped");
  reopened.close();

  const canonical = await buildEnglishReleaseFromProduction(path, {
    outputDirectory: join(root, "canonical-release"),
    version: "canonical-test",
    createdAt: "2026-08-07T00:00:00.000Z"
  });
  const published = openEnglishDictionary(canonical.sqlite);
  expect(published.lookup("bank")?.headword).toBe("bank");
  expect(published.lookup("lead")?.senses).toEqual(refreshedLead.senses);
  published.close();
});

function sourceRecord(headword = "bank"): EnglishSourceRecord {
  const isLead = headword === "lead";
  return {
    source: "open-english-wordnet", sourceVersion: "2025", sourceEntryId: headword,
    license: "CC-BY-4.0", attribution: "Open English WordNet contributors", rawRecord: { id: headword },
    headword, pronunciations: [], senses: [{
      evidenceId: `open-english-wordnet:${headword}:1`, partOfSpeech: "noun",
      definition: isLead ? "an element used to connect an electrical circuit" : "a financial institution",
      registers: [], regions: [], domains: isLead ? ["electronics"] : ["finance"], dated: false, usage: [], examples: []
    }]
  };
}

function generatedEntry(): EnglishEntry {
  return {
    id: "yori:en:e_lead", dictionary: "en", headword: "lead", pronunciations: [], sources: [], senses: [{
      id: "yori:en:s_lead", position: 1, partOfSpeech: "verb", definition: "to guide",
      registers: [], regions: [], domains: [], dated: false, usage: ["transitive"], examples: [],
      evidenceIds: [], provenance: "generated", generation: {
        model: "openai/gpt-5.6-luna", provider: "openrouter", reasoningEffort: "minimal",
        promptVersion: "english-entry-author-v1", serviceTier: "flex"
      }
    }]
  };
}

function attemptRecord(): AttemptRecord {
  return {
    candidateId: "yori:en:e_lead", role: "entry-author", promptVersion: "english-entry-author-v1",
    model: "openai/gpt-5.6-luna", reasoningEffort: "minimal", provider: "openrouter",
    requestedServiceTier: "flex", effectiveServiceTier: "flex", requestId: "request-1",
    durationMs: 10, inputTokens: 10, outputTokens: 10, outcome: "candidate"
  };
}
