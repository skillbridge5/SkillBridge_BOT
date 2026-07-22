#!/bin/bash
# SkillBridge Bot - Database Backup Script
# Run via cron: 0 2 * * * /path/to/SkillBrige\ Bot/backup.sh

set -e

DB_PATH="${DB_PATH:-skillbridge.db}"
BACKUP_DIR="backups"
MAX_BACKUPS=30

mkdir -p "$BACKUP_DIR"

DATE=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_FILE="$BACKUP_DIR/skillbridge_${DATE}.db"

# Use SQLite backup API for safe copy (no locking issues)
if command -v sqlite3 &>/dev/null; then
  sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"
else
  cp "$DB_PATH" "$BACKUP_FILE"
  cp "${DB_PATH}-wal" "$BACKUP_FILE-wal" 2>/dev/null || true
  cp "${DB_PATH}-shm" "$BACKUP_FILE-shm" 2>/dev/null || true
fi

echo "[$(date)] Backup created: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# Cleanup old backups
BACKUP_COUNT=$(ls -1 "$BACKUP_DIR"/skillbridge_*.db 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt "$MAX_BACKUPS" ]; then
  ls -1t "$BACKUP_DIR"/skillbridge_*.db | tail -n +$((MAX_BACKUPS + 1)) | xargs rm -f
  echo "[$(date)] Cleaned up old backups. Keeping $MAX_BACKUPS."
fi
