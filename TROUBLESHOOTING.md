# Troubleshooting Guide

Common issues and solutions for Yori Dict.

## Table of Contents

- [Import Issues](#import-issues)
- [Build Issues](#build-issues)
- [Database Issues](#database-issues)
- [Git LFS Issues](#git-lfs-issues)
- [Docker Issues](#docker-issues)
- [API Issues](#api-issues)

---

## Import Issues

### Import fails with network error

**Cause:** Download failed or corrupted cache.

**Solution:**
```bash
# Clear cache and re-download
rm -rf data/cache
bun run import:jmdict --lang en
```

### Language filtering behavior (JMdict)

JMdict glosses are filtered by requested language during import:

- `en`: accepts `eng` glosses **and** untagged glosses (JMdict default is English)
- `de`: accepts only `ger` tagged glosses

This prevents mixed-language definitions in non-English files.

### Import mode behavior

All import scripts support three modes:

| Mode | Behavior |
|------|----------|
| `merge` (default) | Add missing keys, merge definitions for existing keys |
| `diff` | Preview `added/updated/unchanged` counts without modifying files |
| `replace` | Full snapshot sync: remove stale keys, then overwrite/add all source keys |

**Examples:**
```bash
# Preview changes
bun run import:jmdict --lang en --mode diff

# Apply merges
bun run import:jmdict --lang en --mode merge

# Complete replace (dangerous - use with caution)
bun run import:jmdict --lang en --mode replace
```

---

## Build Issues

### Build failed: "No language files found"

**Cause:** No `data/*.json` files present.

**Solution:**
```bash
# Option A: Pull from Git LFS (if you have LFS data)
bun run data:pull

# Option B: Import fresh data
bun run import:jmdict --lang en
bun run build:db
```

### Build failed: "SyntaxError: Failed to parse JSON"

**Cause:** `data/{lang}.json` is still a Git LFS pointer file, not actual JSON.

**Solution:**
```bash
# Materialize LFS-tracked files
bun run data:pull

# Rebuild database
bun run build:db
```

**Check if file is LFS pointer:**
```bash
head -5 data/en.json
# If you see: "version https://git-lfs.github.com/spec/v1"
# Then it's still a pointer, not the actual JSON
```

### SQLiteError: no such table: main.words

**Cause:** Interrupted build left SQLite sidecar files.

**Solution:**
```bash
# Clean up and rebuild
rm -f dict.sqlite dict.sqlite-shm dict.sqlite-wal
bun run build:db
```

### File is a Git LFS pointer, not JSON

**Cause:** Attempting to build before pulling LFS objects.

**Solution:**
```bash
# Pull LFS objects
bun run data:pull

# Or manually:
git lfs pull --include="data/*.json"

# Then build
bun run build:db
```

---

## Database Issues

### Database locked errors

**Cause:** Multiple processes accessing the database simultaneously.

**Solutions:**

1. **Development:** Ensure only one server instance is running
   ```bash
   # Find and kill other processes
   lsof -i :3000
   kill -9 <PID>
   ```

2. **Production:** Use a persistent volume for `DATABASE_PATH`
   ```bash
   # Example with Docker
   docker run -v /persistent/data:/data -e DATABASE_PATH=/data/dict.sqlite yori-dict
   ```

### Word not found for common words

**Check if word exists:**
```bash
sqlite3 dict.sqlite "SELECT * FROM words WHERE word = '食べる'"
```

**If missing, re-import:**
```bash
bun run import:jmdict --lang en --mode replace
bun run build:db
```

**Check entry count:**
```bash
sqlite3 dict.sqlite "SELECT COUNT(*) FROM words"
```

### Missing translations for a language

**Check what's available:**
```bash
sqlite3 dict.sqlite "SELECT lang, COUNT(*) FROM translations GROUP BY lang"
```

**If empty, import that language:**
```bash
bun run import:jmdict --lang de
bun run build:db
```

---

## Git LFS Issues

### Git LFS not installed

**Error:** `git lfs` command not found.

**Solution:**
```bash
# Install Git LFS
git lfs install

# Or on macOS
brew install git-lfs
git lfs install
```

### Files are LFS pointers after clone

**Cause:** Git LFS wasn't installed before cloning.

**Solution:**
```bash
# Install LFS and pull files
git lfs install
git lfs pull

# Or use the helper script
bun run data:pull
```

### Large files not tracked by LFS

**Check .gitattributes:**
```bash
cat .gitattributes
```

Should contain:
```
data/*.json filter=lfs diff=lfs merge=lfs -text
data/cache/*.json filter=lfs diff=lfs merge=lfs -text
```

**Track new large files:**
```bash
git lfs track "data/*.json"
git add .gitattributes
```

---

## Docker Issues

### Docker build sees LFS pointer files

**Error:** Build fails because Docker context includes LFS pointers instead of actual files.

**Cause:** Git LFS files must be materialized on host before building.

**Solution:**
```bash
# Materialize files on host
bun run data:pull

# Then build
bun run docker:build
```

### Docker image too large

**Expected:** ~100MB production image

**If larger:**
- Ensure `.dockerignore` excludes `data/cache/`, `node_modules/`, etc.
- Check Dockerfile uses multi-stage build

### Container can't find database

**Cause:** Database not built in image or wrong path.

**Solution:**
```bash
# Ensure build happens in Dockerfile
# Check Dockerfile includes:
#   RUN bun run build:db

# Or mount database as volume
docker run -v $(pwd)/dict.sqlite:/app/dict.sqlite yori-dict
```

---

## API Issues

### CORS errors from frontend

**Cause:** CORS headers not set or wrong origin.

**Check:** CORS is enabled by default in `src/index.ts`:
```typescript
app.use('*', cors())
```

**For production:**
```typescript
// Restrict to specific origins
app.use('*', cors({
  origin: ['https://yourapp.com'],
  credentials: true
}))
```

### Slow response times

**Expected:** ~1ms for cached queries

**If slow:**
1. Check indexes exist:
   ```sql
   sqlite3 dict.sqlite ".indexes"
   ```

2. Check database size:
   ```bash
   ls -lh dict.sqlite
   ```

3. Run query directly:
   ```bash
   time sqlite3 dict.sqlite "SELECT * FROM words WHERE word = '食べる' LIMIT 1"
   ```

### Conjugations missing

**Cause:** Part-of-speech tags not matching conjugator patterns.

**Check POS:**
```bash
curl "localhost:3000/v1/lookup?word=食べる" | jq '.partOfSpeech'
```

**Should include:** `ichidan verb`, `godan verb`, `suru verb`, `kuru verb`, or `i-adjective`

**If missing:** The word might not be tagged correctly in the source data. You can add manual entries with correct POS tags.

---

## Performance Debugging

### Check database size and row counts

```bash
# File size
ls -lh dict.sqlite

# Row counts
sqlite3 dict.sqlite "
SELECT 'words' as table_name, COUNT(*) as count FROM words
UNION ALL
SELECT 'translations', COUNT(*) FROM translations
UNION ALL
SELECT 'examples', COUNT(*) FROM examples;
"
```

### Profile a specific query

```bash
# Enable query profiling
sqlite3 dict.sqlite "
.explain
QUERY PLAN
SELECT * FROM words 
WHERE word = '食べる' OR reading = 'たべる'
ORDER BY common DESC
LIMIT 1;
"
```

### Check for index usage

```sql
-- Should use idx_words_word or idx_words_reading
EXPLAIN QUERY PLAN
SELECT * FROM words WHERE word = '食べる';
```

---

## Getting Help

If your issue isn't covered here:

1. Check existing [GitHub Issues](https://github.com/user/yori-dict/issues)
2. Enable debug logging:
   ```bash
   DEBUG=1 bun run dev
   ```
3. Include in bug reports:
   - Command you ran
   - Full error message
   - `dict.sqlite` file size
   - `bun --version` output
