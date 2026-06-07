import { createApp } from "./app";
import { openLookupDb } from "./db";

const dbPath = process.env.YORI_DB_PATH ?? "data/yori.sqlite";
const db = openLookupDb(dbPath);
const app = createApp(db);

export default app;
