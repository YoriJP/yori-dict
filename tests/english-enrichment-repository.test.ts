import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEnglishEnrichmentRepository } from "../src/english-enrichment-repository";
import { buildEnglishRelease } from "../src/english-release";
import type { AttemptRecord } from "../src/on-demand-dictionary";
import type { EnglishEntry, EnglishExample, EnglishSourceRecord } from "../src/english-types";

test("English staging persists accepted entries, examples, attempts, and source discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "yori-en-overlay-"));
  const source = sourceRecord();
  const release = await buildEnglishRelease([source], {
    outputDirectory: join(root, "release"), version: "test", createdAt: "2026-08-06T00:00:00.000Z"
  });
  const overlayPath = join(root, "overlay.sqlite");
  const first = openEnglishEnrichmentRepository(overlayPath, release.sqlite);
  const entry = generatedEntry();
  const example: EnglishExample = { text: "She leads the team.", source: "generated", reviewStatus: "checked" };
  const attempt = attemptRecord();

  expect(first.findReleased("bank")?.headword).toBe("bank");
  expect(first.findSources("bank")).toEqual([source]);
  first.saveEntry(entry);
  first.saveExample(entry.senses[0].id, example);
  first.recordAttempt(attempt);
  first.saveTerminalOutcome("request:en:nope", "skipped");
  first.close();

  const reopened = openEnglishEnrichmentRepository(overlayPath, release.sqlite);
  expect(reopened.findOverlay("lead")?.senses[0].examples).toEqual([example]);
  expect(reopened.acceptedEntries()).toEqual([{ ...entry, senses: [{ ...entry.senses[0], examples: [example] }] }]);
  expect(reopened.attemptRecords()).toEqual([attempt]);
  expect(reopened.terminalOutcome("request:en:nope")).toBe("skipped");
  reopened.close();
});

function sourceRecord(): EnglishSourceRecord {
  return {
    source: "open-english-wordnet", sourceVersion: "2025", sourceEntryId: "bank",
    license: "CC-BY-4.0", attribution: "Open English WordNet contributors", rawRecord: { id: "bank" },
    headword: "bank", pronunciations: [], senses: [{
      evidenceId: "open-english-wordnet:bank:1", partOfSpeech: "noun", definition: "a financial institution",
      registers: [], regions: [], domains: ["finance"], dated: false, usage: [], examples: []
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
