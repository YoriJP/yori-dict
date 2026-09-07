import type { Database } from "bun:sqlite";
import { japaneseSchemaVersion } from "./japanese-schema";

export type JapaneseEvidenceSnapshot = Readonly<{
  schemaVersion: string | null;
  dictDate: string | null;
  jmdictSimplifiedVersion: string | null;
}>;

const metadataKeys = ["schemaVersion", "dictDate", "jmdictSimplifiedVersion"] as const;

export function readJapaneseEvidenceSnapshot(db: Database): JapaneseEvidenceSnapshot {
  const rows = db.query<{ key: string; value: string }, []>(`
    select key, value from ja_metadata
     where key in ('schemaVersion', 'dictDate', 'jmdictSimplifiedVersion')
  `).all();
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return {
    schemaVersion: values.get("schemaVersion") ?? null,
    dictDate: values.get("dictDate") ?? null,
    jmdictSimplifiedVersion: values.get("jmdictSimplifiedVersion") ?? null
  };
}

export function writeJapaneseEvidenceSnapshot(
  db: Database,
  snapshot: JapaneseEvidenceSnapshot
): void {
  const upsert = db.prepare("insert or replace into ja_metadata (key, value) values (?, ?)");
  const remove = db.prepare("delete from ja_metadata where key = ?");
  for (const key of metadataKeys) {
    const value = snapshot[key];
    if (value === null) remove.run(key);
    else upsert.run(key, value);
  }
}

export function sameJapaneseEvidenceSnapshot(
  left: JapaneseEvidenceSnapshot,
  right: JapaneseEvidenceSnapshot
): boolean {
  return metadataKeys.every((key) => left[key] === right[key]);
}

export function assertPublishableJapaneseEvidenceSnapshot(
  snapshot: JapaneseEvidenceSnapshot
): void {
  if (snapshot.schemaVersion !== japaneseSchemaVersion) {
    throw new Error(
      `Japanese release requires classified schema ${japaneseSchemaVersion}; `
      + `found ${snapshot.schemaVersion ?? "no schemaVersion"}. `
      + "Run an explicit Japanese rebuild or import before publishing."
    );
  }
  if (!snapshot.jmdictSimplifiedVersion) {
    throw new Error(
      "Japanese release requires a JMdict inventory version. "
      + "Rebuild from a versioned JMdict source before publishing."
    );
  }
}

export class JapaneseEvidenceSnapshotChangedError extends Error {
  constructor(
    readonly expected: JapaneseEvidenceSnapshot,
    readonly current: JapaneseEvidenceSnapshot
  ) {
    const changed = metadataKeys.filter((key) => expected[key] !== current[key]);
    super(`Japanese Evidence snapshot changed: ${changed.join(", ")}`);
    this.name = "JapaneseEvidenceSnapshotChangedError";
  }
}

export function assertJapaneseEvidenceSnapshotCurrent(
  db: Database,
  expected: JapaneseEvidenceSnapshot
): JapaneseEvidenceSnapshot {
  const current = readJapaneseEvidenceSnapshot(db);
  if (!sameJapaneseEvidenceSnapshot(current, expected)) {
    throw new JapaneseEvidenceSnapshotChangedError(expected, current);
  }
  return current;
}
