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
  { query: "高くない", expectedEntryId: "yori:e_jmdict_1283190" },
  // Bare kana. Each of these reaches several entries that all carry a common
  // form of the reading, so they are the queries where entry ordering, not
  // matching, decides the answer. They are checked against the release rather
  // than a fixture because the ordering leans on Estimated Level, and only the
  // real data says which entries carry a band.
  { query: "こと", expectedEntryId: "yori:e_jmdict_1313580" }, // 事, not 琴
  { query: "よう", expectedEntryId: "yori:e_jmdict_1546200" }, // 用, not 酔う
  { query: "とき", expectedEntryId: "yori:e_jmdict_1315840" }, // 時
  { query: "あと", expectedEntryId: "yori:e_jmdict_1269320" }, // 後, not 跡
  { query: "なか", expectedEntryId: "yori:e_jmdict_1423310" }, // 中, not 仲
  { query: "もの", expectedEntryId: "yori:e_jmdict_2780660" }, // もの: the query is the entry's own form
  { query: "ため", expectedEntryId: "yori:e_jmdict_1157080" }, // 為
  { query: "ところ", expectedEntryId: "yori:e_jmdict_1343100" }, // 所
  { query: "うち", expectedEntryId: "yori:e_jmdict_1457730" }, // 内: 家 is unbanded, see findEntryIds
  { query: "ほか", expectedEntryId: "yori:e_jmdict_1203260" } // 他
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
