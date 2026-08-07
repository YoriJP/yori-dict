import { resolve } from "node:path";
import {
  importEnglishRelease,
  importJapaneseRelease,
  migrateProductionDatabase
} from "../src/production-database";

const path = resolve(process.env.YORI_DB_PATH ?? "data/yori.sqlite");
const japanese = flag("--japanese");
const english = flag("--english");
if (!japanese && !english) {
  throw new Error("Pass --japanese <release.sqlite>, --english <release.sqlite>, or both");
}

migrateProductionDatabase(path);
const result = {
  japanese: japanese ? importJapaneseRelease(path, resolve(japanese)) : false,
  english: english ? importEnglishRelease(path, resolve(english)) : false
};
console.log(JSON.stringify({ event: "production_data_imported", path, ...result }));

function flag(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? null : Bun.argv[index + 1] ?? null;
}
