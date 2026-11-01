# Deploy: smsgw on waybill7

Host `waybill7` (`185.231.115.73`, Debian 13, ssh port 25460). DNS `smsgw.kimiasoft.ir` is on ArvanCDN → this IP.
Server notes: `E:\www\myLan\waybill7.md`. Passwords: `credentials.md` (git-ignored, local only).

| Thing | Value |
|---|---|
| Code | `/var/www/smsgw` (root-owned, read-only for the service) |
| Unit | `smsgw.service` (`www-data`, `127.0.0.1:25465`, `MemoryMax=300M`) |
| Settings | `/etc/smsgw.env` (`640 root:www-data`): `DATABASE_URL`, `ADMIN_PASS_HASH`, `SESSION_SECRET` |
| DB | PostgreSQL 17 (shared server, `127.0.0.1`), database + role `smsgw` |
| Vhost | `/etc/apache2/sites-available/smsgw.kimiasoft.ir.conf` (`:80` + `:443`, self-signed origin cert) |
| CDN IP list | `/etc/apache2/smsgw-arvan-ips.conf`, refreshed weekly by `/etc/cron.weekly/smsgw-arvan-ips` |
| DB backup | `/etc/cron.daily/smsgw-backup` → `/var/backups/smsgw` (newest 14). Not in the off-site Parspack job yet |

## Update

```bash
bash deploy/deploy.sh          # from the project root
```

It uploads `src public scripts deploy package*.json` (never `.md`, `reference-docs`, `credentials.md`, `.env`),
runs `npm ci --omit=dev`, swaps the folder (old code saved as `/root/smsgw-code-<time>.tgz`), installs the unit
and vhost, restarts, reloads Apache and checks `/`. Migrations run when the service starts.

## First-time setup (already done)

1. Role + database: `CREATE ROLE smsgw LOGIN PASSWORD '...'; CREATE DATABASE smsgw OWNER smsgw;`
2. `/etc/smsgw.env` from `.env.example` (admin hash: `node scripts/hash-password.js "password"`).
3. `a2enmod remoteip` (the vhost uses `proxy proxy_http ssl macro headers`, already on).
4. `bash deploy/deploy.sh`.

## Check

```bash
ssh waybill7 "systemctl is-active smsgw; curl -s -H 'Host: smsgw.kimiasoft.ir' http://127.0.0.1/ | head -3"
curl -s -o /dev/null -w '%{http_code}\n' https://smsgw.kimiasoft.ir/            # 200 under construction
curl -s -o /dev/null -w '%{http_code}\n' https://smsgw.kimiasoft.ir/wp-admin/   # 404
curl -s https://smsgw.kimiasoft.ir/api/v1/me                                    # 401 JSON
ssh waybill7 "journalctl -u smsgw -n 30 --no-pager"
```

## Notes

- Set Arvan to **redirect HTTP → HTTPS** for this host. The admin cookie is `Secure` when the request is HTTPS.
- Arvan must send `AR-Real-IP`. Check with a token: `GET /api/v1/usage` returns the `ip` the gateway sees; it must be your own IP,
  not an Arvan address.
- Rollback: `tar xzf /root/smsgw-code-<time>.tgz -C /var/www/smsgw` (after `rm -rf` of the folder contents) and `systemctl restart smsgw`.
  DB restore: `gunzip -c /var/backups/smsgw/<file> | runuser -u postgres -- psql smsgw`.
- Next free app port on waybill7 after this: `25466` (`25464` is used by brainymemo-telegram, not free as the old notes said).
