# Private internet deployment

Novella runs behind the shared Caddy reverse proxy managed separately at `/opt/web-edge`. The Novella Compose project starts only the application and its private LanguageTool service: it does not publish host ports, terminate TLS, manage certificates, or mount the Docker socket.

Every Microsoft Entra identity receives a private SQLite-backed novel library keyed by the immutable combination of tenant ID (`tid`) and object ID (`oid`). Email and display name are metadata only.

## Requirements

- The Neoscion Web host with Docker Engine and Docker Compose v2
- The shared external Docker network named `web`
- The separately managed Caddy deployment at `/opt/web-edge`, joined to `web`
- DNS and Cloudflare configured for `novella.neoscion.com`
- A single-tenant Microsoft Entra app registration in the organization's tenant
- Node.js 24 or newer for development outside Docker
- About 768 MiB of additional memory for the default LanguageTool limit

Create the shared network once if it does not already exist. On the production host, coordinate this with the Web Edge operator:

```sh
docker network inspect web >/dev/null 2>&1 || docker network create web
```

## 1. Configure Microsoft Entra ID

In the Entra admin center, configure the app registration as follows:

1. Leave **Supported account types** set to accounts in this organizational directory only.
2. Under **Authentication**, add these **Web** redirect URIs:

   ```text
   https://novella.neoscion.com/auth/entra/callback
   https://novella.neoscion.com/
   ```

3. Create a client secret and copy its **Value** into the server's private `.env`. Do not use the secret ID and do not commit or log the value.
4. Do not enable implicit grant or hybrid flow. Novella uses authorization code flow with PKCE.
5. Do not add Microsoft Graph permissions. Novella requests only `openid profile email` and does not call Graph.
6. No optional token claims are required. The `profile` scope supplies `oid`; `tid` and `oid` determine library ownership.

Enable **Assignment required** on the Enterprise Application and assign the intended users or group when practical. Otherwise, any eligible user in the tenant can sign in and will receive a separate library.

## 2. Configure the environment

Copy the example, protect it, and edit every placeholder:

```sh
cp .env.example .env
chmod 600 .env
openssl rand -base64 48 | tr -d '\n'
```

Configure authentication and storage:

```dotenv
AUTH_REQUIRED=true
SESSION_SECRET=replace-with-the-generated-value
DATABASE_FILE=/app/data/novella.sqlite
ENTRA_TENANT_ID=your-tenant-guid
ENTRA_CLIENT_ID=your-application-client-id
ENTRA_CLIENT_SECRET=your-client-secret-value
ENTRA_REDIRECT_URI=https://novella.neoscion.com/auth/entra/callback
ENTRA_POST_LOGOUT_REDIRECT_URI=https://novella.neoscion.com/
```

The redirect URI is also Novella's trusted public origin. The application does not use arbitrary `Forwarded` or `X-Forwarded-*` values for cookie security or same-origin decisions. With the production HTTPS redirect configured, session cookies remain `Secure`, `HttpOnly`, and `SameSite=Lax`; state-changing requests continue to require the configured origin, and logout retains its session-bound CSRF token.

Rotating `SESSION_SECRET` signs out every session but does not affect manuscripts or database ownership.

Proofreading is enabled in Compose by default:

```dotenv
PROOFREADING_ENABLED=true
PROOFREADING_URL=http://languagetool:8010
PROOFREADING_TIMEOUT_MS=8000
PROOFREADING_LANGUAGE=en-US
PROOFREADING_MAX_CONCURRENT=2
LANGUAGETOOL_JAVA_XMS=256m
LANGUAGETOOL_JAVA_XMX=512m
LANGUAGETOOL_MEMORY_LIMIT=768m
LANGUAGETOOL_CPU_LIMIT=1.0
```

`PROOFREADING_URL` is server-only and must remain the private service URL. Set `PROOFREADING_ENABLED=false` to run without the checker; writing, saving, browser spellcheck, preview, narration, and export continue to work.

The stack preserves the digest-pinned `erikvl87/languagetool` 6.8 image. LanguageTool runs unprivileged with a read-only root filesystem, a small `/tmp` tmpfs, and no published port. It joins only the internal `novella_proofreading` network. Routine checker logs are reduced to errors with `deployment/languagetool-logback.xml`.

## 3. Prepare persistent data

The repository's `./data` directory is bind-mounted at `/app/data`, and the database remains `/app/data/novella.sqlite`. Before first start, make the directory writable by the image's existing `node` user without making it world-writable. Confirm the UID/GID from the built image if the base image changes; it is currently 1000:1000.

```sh
mkdir -p data
sudo chown -R 1000:1000 data
sudo chmod 750 data
```

Do not place production data in Git or start a second writable Novella instance against a copied or shared database.

### Optional legacy JSON import

Complete an existing JSON-library import before the owner first signs in, so sample records cannot conflict with imported IDs:

```sh
docker compose build novella
docker compose run --rm --no-deps novella npm run migrate:json -- \
  --tenant-id <tenant-guid> \
  --object-id <owner-object-guid> \
  --email owner@example.com \
  --name "Example Owner"
```

The importer uses only tenant ID and object ID for ownership, imports transactionally, is idempotent for identical data, rejects conflicting content, and leaves legacy JSON files untouched.

## 4. Configure the shared Caddy edge

Do not add Caddy to this repository or Compose project. The Web Edge operator should install this separate file as `/opt/web-edge/sites/novella.neoscion.com.caddy`:

```caddyfile
novella.neoscion.com {
    reverse_proxy novella-app:4173
    encode zstd gzip
    header {
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
        X-Frame-Options SAMEORIGIN
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
    }
}
```

`novella-app` is the explicit alias assigned to Novella on the external `web` network. It must match both `compose.yaml` and the Caddy snippet. Caddy adds transport and browser-security headers only; Entra remains the sole authentication layer.

Validate and reload the separately managed edge using its own documented procedure. This repository must not edit or deploy `/opt/web-edge`. After both projects are running, verify upstream reachability from a container on `web` (substitute the actual Caddy container name if needed):

```sh
docker exec caddy wget -qO- http://novella-app:4173/api/health
```

The response must be only `{"ok":true}`.

## 5. Deploy Novella

The standard deployment command is:

```sh
docker compose up -d --build
```

Useful validation and diagnostic commands are:

```sh
docker compose config --quiet
docker compose ps
docker compose logs -f novella languagetool
```

Novella fails fast when authentication values are missing, the session secret is too short, or the database cannot be opened. Neither service publishes a host port. LanguageTool is not a startup dependency: if it is unavailable, proofreading reports that state while the rest of Novella remains usable.

## 6. Verify the deployment

Confirm network exposure and service health:

```sh
docker inspect "$(docker compose ps -q novella)" --format '{{json .HostConfig.PortBindings}}'
docker inspect "$(docker compose ps -q languagetool)" --format '{{json .HostConfig.PortBindings}}'
docker compose exec novella node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>r.text()).then(console.log)"
docker compose exec novella node -e "fetch('http://languagetool:8010/v2/check',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'language=en-US&text=This+are+a+test'}).then(r=>console.log(r.status))"
```

Both port-binding inspections should print `{}`. The health response should be `{"ok":true}`, and the LanguageTool check should print `200`. Do not include manuscript text in checks or logs.

Then verify the public hostname:

```sh
curl -I https://novella.neoscion.com/
curl -I https://novella.neoscion.com/api/health
```

Verify all of the following in a browser:

1. Entra login completes through the configured HTTPS callback and sign-out returns to the configured HTTPS URI.
2. Manuscripts, characters, locations, and dictionaries are present.
3. Editing, autosave, refresh, Markdown preview, and export work.
4. Narration and scene playback work when ElevenLabs is configured.
5. Scene and chapter proofreading work.
6. A second assigned Entra identity cannot access the first identity's novels.
7. Restarting Novella preserves the database and signed-in library.

## Local development

```sh
npm install
npm run dev
```

Open `http://localhost:4173`. Authentication-disabled development uses a fixed local-only identity in `data/novella.sqlite`; it does not overlap with an Entra identity. For local Entra testing, register `http://localhost:4173/auth/entra/callback` and `http://localhost:4173/`, create an ignored `.env.local` with local HTTP redirect values, and run `node --env-file=.env.local server.js`.

## Backup and restore

SQLite may have `novella.sqlite-wal` and `novella.sqlite-shm` companions while Novella is running. The database contains manuscripts, characters, locations, and dictionaries. Never copy only the main file from a live instance and assume it is consistent.

For a simple consistent backup, arrange a write-free window and stop Novella first:

```sh
docker compose stop novella
cp -a data/novella.sqlite* /secure/backup/location/
docker compose start novella
```

Some companion files may not exist after a clean shutdown; that is normal. Alternatively, use SQLite's online backup API correctly. Store a separate encrypted, off-host copy of the database and production `.env`.

To restore on a new host:

1. Keep the destination Novella service stopped.
2. Preserve any existing destination database; never overwrite it without a verified backup.
3. Copy the consistent backup and any required WAL/SHM companions into `./data`.
4. Set ownership to UID/GID 1000 and restrictive permissions.
5. Run `sqlite3 data/novella.sqlite 'PRAGMA integrity_check;'` before starting the app.
6. Start Novella and complete the verification checklist.

## Migration and DNS cutover

1. Identify the old deployment's actual Compose directory, bind-mounted `data/` directory, SQLite file, WAL/SHM companions, and encrypted `.env`. Do not assume repository defaults describe production.
2. Arrange a write-free window and stop the old application.
3. Take a consistent SQLite backup and separate off-host copy.
4. Restore to the Web host with the ownership and integrity checks above.
5. Start Novella, verify Caddy reachability, and test application, Entra, narration, proofreading, and identity isolation.
6. Confirm Cloudflare SSL/TLS mode, DNS target, HTTPS redirects, callback URI, and health endpoint before switching DNS.
7. Switch DNS only after validation. Never run the old and new production instances writable at the same time.
8. Keep the old VM stopped but intact for rollback until the new deployment and backups are verified.

## Updates and rollback

Apply a later approved update with the standard deployment command:

```sh
git pull --ff-only
docker compose up -d --build
```

For rollback, stop Novella and take a consistent backup if any new writes occurred. Restore the preceding application revision and matching `.env` without deleting current data. Preserve the current database separately before restoring any older database backup. Redeploy with the standard command and repeat verification. Change DNS back only after confirming the old host cannot conflict as another writable instance.

## Security notes

- Never publish ports 4173 or 8010 directly.
- Keep `.env` mode `0600`; never commit secrets or the SQLite database.
- Library ownership uses only validated `tid` and `oid`; email is never an authorization key.
- Novella uses an `HttpOnly`, `SameSite=Lax`, `Secure` production session cookie.
- State-changing requests enforce the configured public origin; logout also uses a session-bound CSRF token.
- `openid-client` validates token signature, issuer, audience, state, nonce, and PKCE; Novella additionally requires the configured tenant and object ID.
- The app requests no refresh token and stores no Entra tokens in SQLite or its session cookie.
- Run only one Novella replica while using SQLite.
- Proofreading text goes only to the private checker for the request duration. Routine logging is disabled, responses are bounded, and upstream errors are sanitized.
- Review the pinned community LanguageTool image before upgrades; update its version and digest together.
