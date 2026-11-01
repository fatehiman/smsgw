#!/bin/bash
# Daily database dump on the server (/etc/cron.daily/smsgw-backup). Keeps the newest 14.
set -euo pipefail
DIR=/var/backups/smsgw
mkdir -p "$DIR"
runuser -u postgres -- pg_dump smsgw | gzip > "$DIR/smsgw-$(date +%Y%m%d-%H%M%S).sql.gz"
ls -1t "$DIR"/smsgw-*.sql.gz | tail -n +15 | xargs -r rm -f
