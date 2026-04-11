# Stage 1: Build immutable release artifacts from JSON
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files first (for layer caching)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source and build scripts needed by build:db
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY openapi.yaml ./

# Copy dictionary JSON snapshots
COPY data/core.json ./data/core.json
COPY data/lang/ ./data/lang/

# Fail early if JSON files are still Git LFS pointers.
RUN for f in data/core.json data/lang/*.json; do \
      if [ -f "$f" ] && head -n 1 "$f" | grep -q "version https://git-lfs.github.com/spec/v1"; then \
        echo "ERROR: $f is a Git LFS pointer. Run 'bun run data:pull' on host before docker build."; \
        exit 1; \
      fi; \
    done

# Build and activate the current immutable release
RUN bun run build:db

# Stage 2: Production image
FROM oven/bun:1-slim

WORKDIR /app

# Copy package files and install production deps only
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source code
COPY src/ ./src/

# Copy runtime scripts used by admin operations
COPY scripts/ ./scripts/

# Copy OpenAPI spec (served at /openapi.yaml and used by /docs)
COPY openapi.yaml ./

# Copy JSON snapshots for admin release operations
COPY --from=builder /app/data/core.json ./data/core.json
COPY --from=builder /app/data/lang/ ./data/lang/

# Copy the active immutable release artifacts
COPY --from=builder /app/releases/ ./releases/

# Expose port (Railway will set PORT env var)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3000}/health || exit 1

# Start server
CMD ["bun", "run", "start"]
