import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  assertJapaneseEvidenceSnapshotCurrent,
  assertPublishableJapaneseEvidenceSnapshot,
  japaneseEvidenceInventoryVersion,
  JapaneseEvidenceSnapshotChangedError,
  readJapaneseEvidenceSnapshot,
  sameJapaneseEvidenceSnapshot,
  type JapaneseEvidenceSnapshot,
  writeJapaneseEvidenceSnapshot
} from "../src/japanese-evidence-snapshot";
import { createJapaneseSchema } from "../src/japanese-schema";

const current: JapaneseEvidenceSnapshot = {
  schemaVersion: "ja-3",
  dictDate: "2026-09-07",
  jmdictSimplifiedVersion: "fixture-v1"
};

test("ordinal inventory identity changes when either JMdict format version or dictionary date changes", () => {
  const identity = japaneseEvidenceInventoryVersion(current);
  expect(japaneseEvidenceInventoryVersion({ ...current })).toBe(identity);
  expect(japaneseEvidenceInventoryVersion({ ...current, dictDate: "2026-09-08" })).not.toBe(identity);
  expect(japaneseEvidenceInventoryVersion({ ...current, jmdictSimplifiedVersion: "fixture-v2" })).not.toBe(identity);
  expect(japaneseEvidenceInventoryVersion({ ...current, dictDate: null })).toBe("unknown");
});

test("snapshot equality changes for every field that controls Japanese Evidence identity", () => {
  const transitions: Array<[string, JapaneseEvidenceSnapshot, boolean]> = [
    ["unchanged", { ...current }, true],
    ["schema migration", { ...current, schemaVersion: "ja-4" }, false],
    ["dictionary refresh", { ...current, dictDate: "2026-09-08" }, false],
    ["Evidence inventory refresh", { ...current, jmdictSimplifiedVersion: "fixture-v2" }, false],
    ["unclassified schema", { ...current, schemaVersion: null }, false],
    ["unknown dictionary date", { ...current, dictDate: null }, false],
    ["unknown Evidence inventory", { ...current, jmdictSimplifiedVersion: null }, false]
  ];

  for (const [name, candidate, expected] of transitions) {
    expect(sameJapaneseEvidenceSnapshot(current, candidate), name).toBe(expected);
  }
});

test("snapshot storage is one round-trip interface for rebuild and runtime consumers", () => {
  const db = new Database(":memory:");
  createJapaneseSchema(db);

  writeJapaneseEvidenceSnapshot(db, current);
  expect(readJapaneseEvidenceSnapshot(db)).toEqual(current);

  const withoutInventory = { ...current, jmdictSimplifiedVersion: null };
  writeJapaneseEvidenceSnapshot(db, withoutInventory);
  expect(readJapaneseEvidenceSnapshot(db)).toEqual(withoutInventory);
  db.close();
});

test("publication and transactional repair checks use the same complete snapshot", () => {
  expect(() => assertPublishableJapaneseEvidenceSnapshot(current)).not.toThrow();
  expect(() => assertPublishableJapaneseEvidenceSnapshot({ ...current, schemaVersion: "ja-2" }))
    .toThrow("Japanese release requires classified schema ja-3");
  expect(() => assertPublishableJapaneseEvidenceSnapshot({ ...current, jmdictSimplifiedVersion: null }))
    .toThrow("Japanese release requires a JMdict inventory version");
  expect(() => assertPublishableJapaneseEvidenceSnapshot({ ...current, dictDate: null }))
    .toThrow("Japanese release requires a dictionary date");

  const db = new Database(":memory:");
  createJapaneseSchema(db);
  writeJapaneseEvidenceSnapshot(db, current);
  expect(assertJapaneseEvidenceSnapshotCurrent(db, current)).toEqual(current);

  writeJapaneseEvidenceSnapshot(db, { ...current, jmdictSimplifiedVersion: "fixture-v2" });
  expect(() => assertJapaneseEvidenceSnapshotCurrent(db, current))
    .toThrow(JapaneseEvidenceSnapshotChangedError);
  db.close();
});
