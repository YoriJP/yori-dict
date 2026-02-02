# Stage 1: Build SQLite database from JSON
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files first (for layer caching)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy build scripts
COPY scripts/import/ ./scripts/import/
COPY scripts/build-db.ts ./scripts/

# Copy per-language dictionary files
COPY data/*.json ./data/

# Build SQLite database from JSON
RUN bun run build:db

# Stage 2: Production image
FROM oven/bun:1-slim

WORKDIR /app

# Copy package files and install production deps only
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source code
COPY src/ ./src/

# Copy built database from builder stage
COPY --from=builder /app/dict.sqlite ./

# Expose port (Railway will set PORT env var)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

# Start server
CMD ["bun", "run", "start"]
