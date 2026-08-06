import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSourceEvidenceIndex } from "../src/source-index";

test("licensed source evidence is indexed by headword and reading without mutation", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "yori-source-")), "source.jsonl");
  const evidence = {
    source: "licensed-test-dictionary",
    sourceEntryId: "42",
    headword: "未知語",
    reading: "みちご",
    senses: [
      {
        evidenceId: "licensed-test-dictionary:42:1",
        partOfSpeech: ["n"],
        glosses: [{ lang: "en", text: "unknown term" }]
      }
    ]
  };
  await Bun.write(path, `${JSON.stringify(evidence)}\n`);

  const index = await openSourceEvidenceIndex([path]);

  expect(index.lookup("未知語", "ja")).toEqual([evidence]);
  expect(index.lookup("みちご", "ja")).toEqual([evidence]);
  expect(index.lookup("missing", "ja")).toEqual([]);
  expect(index.lookup("未知語", "en")).toEqual([]);
});
