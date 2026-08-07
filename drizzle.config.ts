import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/production-schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.YORI_DB_PATH ?? "data/yori.sqlite"
  }
});
