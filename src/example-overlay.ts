import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PublicExample, PublicLookupItem } from "./types";

export type ModelProvenance = {
  model: string;
  reasoningEffort: string;
  provider: string;
};

export type EnrichmentAttempt = {
  candidateId: string;
  generator: ModelProvenance;
  translator?: ModelProvenance;
  reviewer?: ModelProvenance;
  candidate?: PublicExample;
  rejectionReason?: string;
};

export type OverlayRecord = {
  senseId: string;
  status: "accepted" | "abstained" | "dropped";
  example?: PublicExample;
  attempts: EnrichmentAttempt[];
  reason?: string;
};

export type ExampleOverlay = {
  read(senseId: string): OverlayRecord | null;
  write(record: OverlayRecord): void;
  accepted(): OverlayRecord[];
  close(): void;
};

export function openExampleOverlay(path: string): ExampleOverlay {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`
    create table if not exists example_enrichments (
      sense_id text primary key,
      status text not null check (status in ('accepted', 'abstained', 'dropped')),
      example_json text,
      attempts_json text not null,
      reason text,
      updated_at text not null
    )
  `);
  const read = db.prepare<{
    sense_id: string;
    status: OverlayRecord["status"];
    example_json: string | null;
    attempts_json: string;
    reason: string | null;
  }, [string]>("select * from example_enrichments where sense_id = ?");
  const upsert = db.prepare(
    `insert into example_enrichments
       (sense_id, status, example_json, attempts_json, reason, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(sense_id) do update set
       status = excluded.status,
       example_json = excluded.example_json,
       attempts_json = excluded.attempts_json,
       reason = excluded.reason,
       updated_at = excluded.updated_at`
  );
  const decode = (row: {
    sense_id: string;
    status: OverlayRecord["status"];
    example_json: string | null;
    attempts_json: string;
    reason: string | null;
  }): OverlayRecord => ({
    senseId: row.sense_id,
    status: row.status,
    ...(row.example_json ? { example: JSON.parse(row.example_json) as PublicExample } : {}),
    attempts: JSON.parse(row.attempts_json) as EnrichmentAttempt[],
    ...(row.reason ? { reason: row.reason } : {})
  });

  return {
    read(senseId) {
      const row = read.get(senseId);
      return row ? decode(row) : null;
    },
    write(record) {
      upsert.run(
        record.senseId,
        record.status,
        record.example ? JSON.stringify(record.example) : null,
        JSON.stringify(record.attempts),
        record.reason ?? null,
        new Date().toISOString()
      );
    },
    accepted() {
      return db
        .query<{
          sense_id: string;
          status: OverlayRecord["status"];
          example_json: string | null;
          attempts_json: string;
          reason: string | null;
        }, []>("select * from example_enrichments where status = 'accepted' order by sense_id")
        .all()
        .map(decode);
    },
    close() {
      db.close();
    }
  };
}

export function applyOverlay(item: PublicLookupItem | null, overlay: ExampleOverlay): PublicLookupItem | null {
  if (!item) return null;
  return {
    ...item,
    senses: item.senses.map((sense) => {
      if (sense.examples && sense.examples.length > 0) return sense;
      const record = overlay.read(sense.id);
      if (record?.status !== "accepted" || !record.example) return sense;
      return { ...sense, examples: [record.example] };
    })
  };
}
