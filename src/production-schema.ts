import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The canonical `ja_*` and `en_*` dictionary tables are installed by their own
// dictionary rebuilds. Drizzle owns the production-only tables around them.

export const productionMetadata = sqliteTable("production_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
});

export const modelAttempts = sqliteTable("model_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dictionary: text("dictionary").notNull(),
  attemptJson: text("attempt_json").notNull(),
  createdAt: text("created_at").notNull()
});

