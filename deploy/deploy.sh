#!/bin/bash
# Deploy smsgw to waybill7 (run from the project root, e.g. in Git Bash):  bash deploy/deploy.sh
# Needs on the server (done once, see DEPLOY.md): /etc/smsgw.env, the smsgw database, a2enmod remoteip.
# Never uploads .md files, reference-docs, credentials.md, .env or tests.
set -euo pipefail
HOST=${HOST:-waybill7}
APP=/var/www/smsgw
TGZ=$(mktemp -u).tgz

tar czf "$TGZ" src public scripts deploy package.json package-lock.json
scp -q "$TGZ" "$HOST:/tmp/smsgw.tgz"
rm -f "$TGZ"

ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
APP=/var/www/smsgw
STAMP=$(date +%Y%m%d-%H%M%S)
NEW=$APP.new

# backup the old code (the DB has its own daily dump)
[ -d $APP/src ] && tar czf /root/smsgw-code-$STAMP.tgz -C $APP . || true

rm -rf $NEW && mkdir -p $NEW
tar xzf /tmp/smsgw.tgz -C $NEW
rm -f /tmp/smsgw.tgz
cd $NEW
npm ci --omit=dev --no-audit --no-fund --loglevel=error
cd /
rm -rf $APP.old
[ -d $APP ] && mv $APP $APP.old
mv $NEW $APP
chown -R root:root $APP
chmod -R go-w $APP
rm -rf $APP.old

# system files
install -m 644 $APP/deploy/smsgw.service /etc/systemd/system/smsgw.service
install -m 644 $APP/deploy/apache-smsgw.conf /etc/apache2/sites-available/smsgw.kimiasoft.ir.conf
install -m 755 $APP/deploy/update-arvan-ips.sh /etc/cron.weekly/smsgw-arvan-ips
install -m 755 $APP/deploy/smsgw-backup.sh /etc/cron.daily/smsgw-backup

# self-signed origin cert (the CDN does not verify it), created once
if [ ! -f /etc/ssl/certs/smsgw.kimiasoft.ir.crt ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj "/CN=smsgw.kimiasoft.ir" \
    -keyout /etc/ssl/private/smsgw.kimiasoft.ir.key -out /etc/ssl/certs/smsgw.kimiasoft.ir.crt 2>/dev/null
  chmod 600 /etc/ssl/private/smsgw.kimiasoft.ir.key
fi
[ -s /etc/apache2/smsgw-arvan-ips.conf ] || /etc/cron.weekly/smsgw-arvan-ips

systemctl daemon-reload
systemctl enable smsgw >/dev/null 2>&1
systemctl restart smsgw
a2ensite smsgw.kimiasoft.ir >/dev/null
apache2ctl configtest
systemctl reload apache2

for i in 1 2 3 4 5; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: smsgw.kimiasoft.ir' http://127.0.0.1/) && [ "$code" = 200 ] && break
  sleep 1
done
echo "origin / -> $code ; smsgw is $(systemctl is-active smsgw)"
REMOTE
