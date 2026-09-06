# Deploying MyTasks

From a WAMP folder to a public server. Nothing here needs Composer, npm, or a
build step — deployment is "copy the files, create a database, write one
`.env`, add two cron jobs."

The whole guide is gated by one command. Run it after every step and again at
the end:

```bash
php api/tools/preflight.php --production
```

It checks PHP version and extensions, secrets, debug flags, folder
permissions, the `.htaccess` guards, class-name casing (Windows is
case-insensitive, Linux is not), the PHP↔MySQL clock offset, and — with
`--url` — whether `.env` and your source are reachable over HTTP.

---

## 1. What you need

| Requirement | Notes |
| --- | --- |
| PHP 8.1+ | `pdo_mysql`, `openssl`, `mbstring`, `json` required; `zip` and `curl` for backups |
| MySQL 5.7+ / MariaDB 10.4+ | utf8mb4 |
| Apache with `mod_rewrite`, `mod_headers` | and `AllowOverride All` for the app directory |
| A TLS certificate | Let's Encrypt is fine. Non-negotiable: the refresh cookie is a 30-day credential |
| Shell access | For `keygen`, `migrate`, `preflight` and cron |

Nginx works too — there is a config below — but Apache is the path of least
resistance, since all the guards ship as `.htaccess` files.

---

## 2. Layout on the server

Keep `api/`, `web/` and `cat-assistant/` siblings. The web client finds the
API by stripping its own folder off its URL, so this layout needs no
configuration at all:

```
/var/www/mytasks/            <- document root
├── .htaccess                blocks archives, dotfiles, .git, directory listings
├── api/
│   ├── .htaccess            front-controller rewrite + header policy
│   ├── .env                 you create this — never in git
│   ├── index.php
│   ├── src/ routes/ database/ storage/ tools/   each with its own deny guard
│   └── storage/{logs,backups}/                  must be writable
├── web/
│   └── .htaccess            CSP and security headers
└── cat-assistant/
    └── .htaccess
```

Do **not** upload: `whisper.cpp/`, `piper/`, `launch.py`, `dev-server.php`,
`.git/`, or any `.zip`. The root `.htaccess` blocks them if they slip through,
but not uploading them is better than blocking them.

```bash
# From a clone, this excludes everything above automatically:
git archive --format=tar HEAD | ssh you@server 'tar -x -C /var/www/mytasks'
```

If the API must live on its own subdomain instead, that works too — set
`APP_URL` accordingly and put the client's origin in `CORS_ALLOWED_ORIGINS`,
then set `REFRESH_COOKIE_SAMESITE=None` **and** `REFRESH_COOKIE_SECURE=true`.
Same-origin is simpler and strictly safer; prefer it unless you have a reason.

---

## 3. Database

```sql
CREATE DATABASE mytasks CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'mytasks'@'localhost' IDENTIFIED BY 'a-long-random-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER, REFERENCES
   ON mytasks.* TO 'mytasks'@'localhost';
FLUSH PRIVILEGES;
```

`CREATE`, `INDEX` and `ALTER` are only there for `tools/migrate.php`. Revoke
them once the schema settles, and grant them back for a migration.

```bash
mysql -u mytasks -p mytasks < api/database/schema.sql
php api/tools/migrate.php          # applies anything past the baseline
php api/tools/migrate.php --status # shows what ran
```

---

## 4. Configuration

```bash
cp api/.env.production.example api/.env
php api/tools/keygen.php --write   # generates APP_KEY and JWT_SECRET in place
$EDITOR api/.env                   # database credentials, APP_URL, SMTP
chmod 600 api/.env
```

Then, **before** you create a single account:

> Copy `APP_KEY` somewhere that is not the same place as the database.
> A password manager, a sealed envelope, another provider — anywhere the
> database backup does not also live. It encrypts every vault password and
> every TOTP secret, it cannot be rotated, and losing it destroys them
> permanently. This is the one irreversible mistake in the whole system.

Permissions:

```bash
chown -R www-data:www-data /var/www/mytasks
chmod -R 755 /var/www/mytasks
chmod -R 775 /var/www/mytasks/api/storage
chmod 600 /var/www/mytasks/api/.env
```

---

## 5. Apache virtual host

```apache
<VirtualHost *:80>
    ServerName tasks.example.com
    Redirect permanent / https://tasks.example.com/
</VirtualHost>

<VirtualHost *:443>
    ServerName tasks.example.com
    DocumentRoot /var/www/mytasks

    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/tasks.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/tasks.example.com/privkey.pem

    # Required — every guard in this project ships as an .htaccess file.
    <Directory /var/www/mytasks>
        AllowOverride All
        Require all granted
        Options -Indexes -MultiViews
    </Directory>

    # Belt and braces: the per-folder .htaccess files already deny these.
    <DirectoryMatch "/var/www/mytasks/api/(src|routes|database|storage|tools)">
        Require all denied
    </DirectoryMatch>

    # Land on the client, not on a directory listing.
    RedirectMatch ^/$ /web/

    ErrorLog  ${APACHE_LOG_DIR}/mytasks-error.log
    CustomLog ${APACHE_LOG_DIR}/mytasks-access.log combined
</VirtualHost>
```

```bash
a2enmod rewrite headers ssl expires
a2ensite mytasks && systemctl reload apache2
```

Also set `expose_php = Off` in `php.ini` so the version stops appearing in
response headers.

### Nginx equivalent

`.htaccess` is ignored by nginx, so the guards have to be restated:

```nginx
server {
    listen 443 ssl http2;
    server_name tasks.example.com;
    root /var/www/mytasks;

    ssl_certificate     /etc/letsencrypt/live/tasks.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tasks.example.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=15768000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;

    location = / { return 302 /web/; }

    # Everything under /api that is not a real file goes to the front controller.
    location /api/ {
        try_files $uri $uri/ /api/index.php$is_args$args;
    }

    # These must never be served.
    location ~ ^/api/(src|routes|database|storage|tools)/ { deny all; }
    location ~ /\.                                        { deny all; }
    location ~ \.(zip|sql|log|bak|old)$                   { deny all; }

    location ~ \.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
    }
}
```

With php-fpm behind nginx, set `TRUSTED_PROXY=true` in `.env` so the app can
see that the browser is on HTTPS.

---

## 6. Cron

Two jobs. The first is not optional — without it, reminders never fire and
four tables grow without bound.

```cron
# Reminders + housekeeping (expired tokens, OTPs, rate buckets, old audit rows)
* * * * * cd /var/www/mytasks/api && php tools/reminders.php >> /var/log/mytasks-reminders.log 2>&1

# Nightly backup, 02:00
0 2 * * * cd /var/www/mytasks/api && php tools/backup.php --upload >> /var/log/mytasks-backup.log 2>&1
```

Run them as the web-server user (`sudo -u www-data crontab -e`), so files the
cron writes stay readable by the app.

---

## 7. Verify

```bash
php api/tools/preflight.php --production --url=https://tasks.example.com/api
php api/tools/selftest.php
php api/tools/smoketest.php --url=https://tasks.example.com/api --cleanup
```

- **preflight** — server fitness, plus a live probe that `.env`, `src/`,
  `storage/logs/mail.log` and `tools/` all return 403/404.
- **selftest** — encryption round-trip and tamper detection, JWT forgery
  rejection, TOTP against the RFC 6238 vectors.
- **smoketest** — registers two accounts and asserts that neither can read,
  update or delete the other's rows. This is the test that guards the entire
  security model; treat a failure here as an outage.

`smoketest` needs to complete a 2FA step, so run it with `MAIL_DRIVER=log`
temporarily, or against a staging copy — not against production with live SMTP.

Then by hand: sign in, enrol TOTP, add a task, store and reveal a vault entry,
and sign out.

---

## 8. Backups are not backups until you restore one

Do this once, now, before you rely on it:

```bash
php api/tools/backup.php
cd api/storage/backups && unzip -o mytasks-backup-*.zip -d /tmp/restore-drill
mysql -u root -p -e "CREATE DATABASE mytasks_drill"
mysql -u root -p mytasks_drill < /tmp/restore-drill/database.sql
```

Then point a scratch `.env` at `mytasks_drill` **with the archived `APP_KEY`**
and reveal one vault entry. If the password comes back readable, the backup is
real. If it does not, you have the wrong key — and that is infinitely better
to learn today than during a restore.

```bash
mysql -u root -p -e "DROP DATABASE mytasks_drill"
rm -rf /tmp/restore-drill
```

---

## 9. The optional local services

Ollama, whisper.cpp and Piper are localhost processes with no authentication
of their own. On typical shared or managed hosting they will not be running —
leave their `.env` values alone and the mic button, spoken replies and the
free-form chat fallback are simply unavailable. Everything else works
identically; each client degrades with an explicit message rather than
pretending.

If you do run them on your own VPS, bind them to `127.0.0.1` only. Exposing
any of them on a public interface hands anyone an unauthenticated endpoint on
your server.

---

## 10. Ongoing

| Cadence | Task |
| --- | --- |
| Every deploy | `php tools/migrate.php`, then `preflight --production` |
| Weekly | Skim `storage/logs/php-error.log`; confirm the backup cron is producing files |
| Monthly | `SELECT action, COUNT(*) FROM audit_logs WHERE created_at > NOW() - INTERVAL 30 DAY GROUP BY action` — `login.failed` and `vault.unlock_failed` spikes are the interesting ones |
| Quarterly | Restore drill (§8). Confirm `APP_KEY` is still backed up where you think it is |
| On any suspicion | `POST /auth/logout-all`, rotate `JWT_SECRET` (kills all sessions; harmless), rotate the DB password. **Never `APP_KEY`** |

---

## Known limitations

Honest list, so none of these is a surprise later.

- **Single server.** Rate limiting is a MySQL table and sessions are rows;
  both work behind a load balancer, but `RateLimiter` was written for one node
  — move it to Redis before scaling out.
- **No admin role.** By design. It also means no user management UI: creating,
  suspending or deleting an account is a SQL statement.
- **`/backup` reaches every user's data** and is gated only by `BACKUP_KEY`.
  Leave that blank unless you actively need the HTTP surface; the CLI tool
  does not use it.
- **Access tokens cannot be revoked** before their 15-minute expiry. Changing
  a password revokes refresh tokens immediately, so the worst case is one
  short window.
- **`APP_KEY` is unrotatable.** Stated three times in this document on purpose.
