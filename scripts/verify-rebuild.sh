#!/usr/bin/env bash
set -euo pipefail

# Verify that rebuild:all produces the same data as the current tree.
# Uses a git worktree to avoid overwriting current files.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE="../yori-dict-rebuild"
TMPDIR_BASE="/tmp/verify-rebuild-$$"
LANGS=(en de ko zh-cn zh-tw)
HAS_DIFF=0

cleanup() {
  echo ""
  echo "=== Cleanup ==="
  cd "$REPO_ROOT"
  git worktree prune >/dev/null 2>&1 || true
  if [ -d "$WORKTREE" ]; then
    git worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf "$WORKTREE"
  fi
  rm -rf "$TMPDIR_BASE"
  echo "Done."
}
trap cleanup EXIT

# Check dependencies
for cmd in jq diff sqlite3; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required but not installed." >&2
    exit 2
  fi
done

# Check cache
if [ ! -d "$REPO_ROOT/data/cache" ] || [ -z "$(ls -A "$REPO_ROOT/data/cache" 2>/dev/null)" ]; then
  echo "Warning: data/cache/ is empty or missing. Imports will download fresh data, which may differ from original." >&2
fi

mkdir -p "$TMPDIR_BASE"

echo "=== Step 1: Create worktree ==="
cd "$REPO_ROOT"
git worktree prune >/dev/null 2>&1 || true
git worktree add "$WORKTREE" HEAD --quiet
echo "Worktree created at $WORKTREE"

echo ""
echo "=== Step 2: Copy cache to worktree ==="
mkdir -p "$WORKTREE/data"
cp -r data/cache "$WORKTREE/data/cache"
echo "Cache copied ($(du -sh data/cache | cut -f1))"

echo ""
echo "=== Step 3: Run rebuild:all in worktree ==="
cd "$WORKTREE"
bun install --frozen-lockfile 2>/dev/null || bun install
echo "Starting rebuild:all (this may take a while)..."
bun run rebuild:all
cd "$REPO_ROOT"

echo ""
echo "=== Step 4: Compare JSON files ==="

compare_json() {
  local label="$1" file_a="$2" file_b="$3" jq_filter="$4"
  local norm_a="$TMPDIR_BASE/$(basename "$file_a" .json)-A.json"
  local norm_b="$TMPDIR_BASE/$(basename "$file_a" .json)-B.json"
  local diff_file="$TMPDIR_BASE/$(basename "$file_a" .json).diff"

  if [ ! -f "$file_a" ]; then
    echo "  SKIP $label — file A not found: $file_a"
    return
  fi
  if [ ! -f "$file_b" ]; then
    echo "  MISS $label — file B not found: $file_b"
    HAS_DIFF=1
    return
  fi

  echo -n "  Comparing $label... "
  jq -S "$jq_filter" "$file_a" > "$norm_a"
  jq -S "$jq_filter" "$file_b" > "$norm_b"

  if diff -q "$norm_a" "$norm_b" &>/dev/null; then
    echo "OK ✓"
  else
    echo "DIFF FOUND ✗"
    HAS_DIFF=1
    # Show a brief summary
    local lines
    diff -u "$norm_a" "$norm_b" > "$diff_file" || true
    lines=$(wc -l < "$diff_file" | tr -d ' ')
    echo "    ($lines lines of diff)"
    sed -n '1,30p' "$diff_file"
    echo "    ..."
    echo "    Full diff: diff -u $norm_a $norm_b"
  fi
}

CORE_FILTER='del(.updatedAt) | .stats |= del(.updatedAt?)'
LANG_FILTER='
  del(.updatedAt)
  | .stats |= del(.updatedAt?)
  | .entries |= with_entries(
      .value |= (
        .definitions |= sort
        | .examples |= sort_by(.ja, .text, .source)
        | ._defSources |= with_entries(.value |= sort)
      )
    )
'

compare_json "core.json" \
  "$REPO_ROOT/data/core.json" \
  "$REPO_ROOT/$WORKTREE/data/core.json" \
  "$CORE_FILTER"

for lang in "${LANGS[@]}"; do
  compare_json "lang/$lang.json" \
    "$REPO_ROOT/data/lang/$lang.json" \
    "$REPO_ROOT/$WORKTREE/data/lang/$lang.json" \
    "$LANG_FILTER"
done

echo ""
echo "=== Step 5: Compare SQLite ==="
DB_A="$REPO_ROOT/dict.sqlite"
DB_B="$REPO_ROOT/$WORKTREE/dict.sqlite"
DB_DIFF_FILE="$TMPDIR_BASE/db.diff"

if [ -f "$DB_A" ] && [ -f "$DB_B" ]; then
  for table in words translations examples; do
    count_a=$(sqlite3 "$DB_A" "SELECT COUNT(*) FROM $table;" 2>/dev/null || echo "N/A")
    count_b=$(sqlite3 "$DB_B" "SELECT COUNT(*) FROM $table;" 2>/dev/null || echo "N/A")
    if [ "$count_a" = "$count_b" ]; then
      echo "  $table: $count_a rows (match ✓)"
    else
      echo "  $table: A=$count_a B=$count_b (MISMATCH ✗)"
      HAS_DIFF=1
    fi
  done

  echo ""
  echo -n "  Full dump diff... "
  sqlite3 "$DB_A" .dump > "$TMPDIR_BASE/db-A.sql"
  sqlite3 "$DB_B" .dump > "$TMPDIR_BASE/db-B.sql"
  if diff -q "$TMPDIR_BASE/db-A.sql" "$TMPDIR_BASE/db-B.sql" &>/dev/null; then
    echo "OK ✓"
  else
    echo "DIFF FOUND ✗"
    HAS_DIFF=1
    diff -u "$TMPDIR_BASE/db-A.sql" "$TMPDIR_BASE/db-B.sql" > "$DB_DIFF_FILE" || true
    sed -n '1,30p' "$DB_DIFF_FILE"
    echo "    Full diff: diff -u $TMPDIR_BASE/db-A.sql $TMPDIR_BASE/db-B.sql"
  fi
elif [ ! -f "$DB_A" ]; then
  echo "  Skipped — no current dict.sqlite (run build:db first if you want DB comparison)"
elif [ ! -f "$DB_B" ]; then
  echo "  Skipped — rebuild did not produce dict.sqlite"
fi

echo ""
echo "==============================="
if [ "$HAS_DIFF" -eq 0 ]; then
  echo "Result: ALL MATCH ✓"
  exit 0
else
  echo "Result: DIFFERENCES FOUND ✗"
  exit 1
fi
