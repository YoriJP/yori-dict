import { openLookupDb } from "../src/db";

type Check = {
  query: string;
  expectedEntryId: string;
};

const dbPath = process.env.YORI_DB_PATH ?? "data/yori.sqlite";
const checks: Check[] = [
  { query: "食べました", expectedEntryId: "yori:e_jmdict_1358280" },
  { query: "学校", expectedEntryId: "yori:e_jmdict_1206730" },
  { query: "読んだ", expectedEntryId: "yori:e_jmdict_1456360" },
  { query: "行かなかった", expectedEntryId: "yori:e_jmdict_1578850" },
  { query: "見せられた", expectedEntryId: "yori:e_jmdict_1259210" },
  { query: "高くない", expectedEntryId: "yori:e_jmdict_1283190" }
];

const db = openLookupDb(dbPath);
let failures = 0;

for (const check of checks) {
  const start = performance.now();
  const result = db.lookup(check.query, "en");
  const elapsedMs = performance.now() - start;
  const ok = result.item?.id === check.expectedEntryId;

  if (!ok) failures += 1;

  console.log(
    [
      ok ? "ok" : "fail",
      check.query,
      `entry=${check.expectedEntryId}`,
      `${elapsedMs.toFixed(2)}ms`
    ].join("\t")
  );
}

db.close();

if (failures > 0) {
  console.error(`${failures} lookup check(s) failed`);
  process.exit(1);
}
