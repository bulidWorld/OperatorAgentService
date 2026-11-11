#!/bin/sh
set -eu

python3 /app/scripts/sync_schema.py --dir /app/db
exec node /app/server.js
