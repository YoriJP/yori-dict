import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ApiLang } from "../src/types";
import type { AiSeed } from "./ai-common";

export type SeedRow = {
  entry_id: string;
  sense_id: string;
  word: string;
  reading: string | null;
  common: 0 | 1;
  position: number;
  part_of_speech: string;
  glosses_json: string;
};

export type SeedSelectionArgs = {
  targetLang: ApiLang;
  limit: number;
  skipKatakana: boolean;
};

export type BlockedSenseArgs = {
  targetLang: ApiLang;
  includeRejected: boolean;
  rejectedDir: string;
  workDir: string;
};

type RejectedRow = {
  senseId?: unknown;
  candidate?: {
    senseId?: unknown;
    targetLang?: unknown;
  };
};

type FailureRow = {
  key?: unknown;
};

export function readBlockedSenseIds(args: BlockedSenseArgs): Set<string> {
  if (args.includeRejected) return new Set();

  return new Set([
    ...readRejectedSenseIds(args.rejectedDir, args.targetLang),
    ...readFailureSenseIds(args.workDir)
  ]);
}

export function prepareBlockedSenseTable(db: Database, blockedSenseIds: Set<string>): void {
  db.run("create temporary table if not exists blocked_senses (id text primary key)");
  db.run("delete from blocked_senses");

  const insert = db.prepare("insert or ignore into blocked_senses (id) values (?)");
  const insertAll = db.transaction((ids: string[]) => {
    for (const id of ids) insert.run(id);
  });
  insertAll([...blockedSenseIds]);
}

export function readMissingSeedRows(db: Database, args: SeedSelectionArgs): SeedRow[] {
  return db
    .query<SeedRow, [ApiLang, number, number]>(
      `select
         e.id as entry_id,
         s.id as sense_id,
         (
           select f.text
           from forms f
           where f.entry_id = e.id
           order by f.common desc, case f.kind when 'kanji' then 0 else 1 end, f.text
           limit 1
         ) as word,
         (
           select f.reading
           from forms f
           where f.entry_id = e.id and f.reading is not null
           order by f.common desc, f.text
           limit 1
         ) as reading,
         (
           select max(f.common)
           from forms f
           where f.entry_id = e.id
         ) as common,
         s.position,
         s.part_of_speech,
         json_group_array(g.text) as glosses_json,
         case
           when exists (
             select 1
             from json_each(s.part_of_speech)
             where value = 'n'
                or value like 'v%'
                or value in ('adj-i', 'adj-na', 'adj-no', 'adv', 'adv-to')
           ) then 0
           when exists (
             select 1
             from json_each(s.part_of_speech)
             where value = 'exp'
           ) then 1
           when exists (
             select 1
             from json_each(s.part_of_speech)
             where value in ('pn', 'num', 'pref', 'suf', 'n-pref', 'n-suf')
           ) then 2
           else 3
         end as lexical_priority,
         count(g.text) as gloss_count,
         sum(length(g.text)) as gloss_text_length
       from entries e
       join senses s on s.entry_id = e.id
       join glosses g on g.sense_id = s.id and g.lang = 'en'
       where not exists (
         select 1
         from glosses target
         where target.sense_id = s.id and target.lang = ?
       )
       and not exists (
         select 1
         from blocked_senses blocked
         where blocked.id = s.id
       )
       and (
         ? = 0
         or not exists (
           select 1
           from forms only_forms
           where only_forms.entry_id = e.id
             and only_forms.kind = 'kana'
             and only_forms.text glob '[ァ-ヴー・]*'
         )
       )
       group by e.id, s.id
       order by
         (
           select max(order_forms.common)
           from forms order_forms
           where order_forms.entry_id = e.id
         ) desc,
         lexical_priority,
         e.source_id,
         s.position,
         gloss_count,
         gloss_text_length
       limit ?`
    )
    .all(args.targetLang, args.skipKatakana ? 1 : 0, args.limit);
}

export function toSeed(row: SeedRow, targetLang: ApiLang): AiSeed {
  return {
    entryId: row.entry_id,
    senseId: row.sense_id,
    word: row.word,
    reading: row.reading,
    common: row.common === 1,
    position: row.position,
    targetLang,
    pos: JSON.parse(row.part_of_speech) as string[],
    glosses: JSON.parse(row.glosses_json) as string[]
  };
}

function readRejectedSenseIds(rejectedDir: string, targetLang: ApiLang): string[] {
  if (!existsSync(rejectedDir)) return [];

  const ids: string[] = [];
  for (const name of readdirSync(rejectedDir)) {
    if (!name.endsWith(".jsonl") || !name.includes("rejected")) continue;

    const fileMatchesLang = name.includes(targetLang);
    for (const row of readJsonlLenient<RejectedRow>(join(rejectedDir, name))) {
      const candidateLang = row.candidate?.targetLang;
      if (typeof candidateLang === "string" && candidateLang !== targetLang) continue;
      if (typeof candidateLang !== "string" && !fileMatchesLang) continue;

      const senseId = typeof row.senseId === "string" ? row.senseId : row.candidate?.senseId;
      if (typeof senseId === "string") ids.push(senseId);
    }
  }

  return ids;
}

function readFailureSenseIds(workDir: string): string[] {
  if (!existsSync(workDir)) return [];

  const ids: string[] = [];
  for (const runName of readdirSync(workDir)) {
    const failuresPath = join(workDir, runName, "failures.jsonl");
    if (!existsSync(failuresPath)) continue;

    for (const row of readJsonlLenient<FailureRow>(failuresPath)) {
      if (typeof row.key === "string") ids.push(row.key);
    }
  }

  return ids;
}

function readJsonlLenient<T>(path: string): T[] {
  const text = readFileSync(path, "utf8");
  const rows: T[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // Ignore malformed local scratch rows. Source validation still checks committed data strictly.
    }
  }

  return rows;
}
