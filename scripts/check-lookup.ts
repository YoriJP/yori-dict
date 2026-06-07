import { openLookupDb } from "../src/db";

type Check = {
  query: string;
  expectedEntryId: string;
  expectedMatchedForm: string;
};

const dbPath = process.env.YORI_DB_PATH ?? "data/yori.sqlite";
const checks: Check[] = [
  { query: "食べました", expectedEntryId: "yori:e_jmdict_1358280", expectedMatchedForm: "食べる" },
  { query: "学校", expectedEntryId: "yori:e_jmdict_1206730", expectedMatchedForm: "学校" },
  { query: "読んだ", expectedEntryId: "yori:e_jmdict_1456360", expectedMatchedForm: "読む" },
  { query: "行かなかった", expectedEntryId: "yori:e_jmdict_1578850", expectedMatchedForm: "行く" },
  { query: "見せられた", expectedEntryId: "yori:e_jmdict_1259210", expectedMatchedForm: "見せる" },
  { query: "高くない", expectedEntryId: "yori:e_jmdict_1283190", expectedMatchedForm: "高い" }
];

const db = openLookupDb(dbPath);
let failures = 0;

for (const check of checks) {
  const start = performance.now();
  const result = db.lookup(check.query, "en");
  const elapsedMs = performance.now() - start;
  const ok =
    result.item?.id === check.expectedEntryId &&
    result.item.matchedFrom.form === check.expectedMatchedForm;

  if (!ok) failures += 1;

  console.log(
    [
      ok ? "ok" : "fail",
      check.query,
      `entry=${check.expectedEntryId}`,
      `matched=${check.expectedMatchedForm}`,
      `${elapsedMs.toFixed(2)}ms`
    ].join("\t")
  );
}

db.close();

if (failures > 0) {
  console.error(`${failures} lookup check(s) failed`);
  process.exit(1);
}
