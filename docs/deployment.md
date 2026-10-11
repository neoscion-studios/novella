# Private internet deployment

This deployment runs Novella behind Traefik with Microsoft Entra ID authentication. Every Entra identity receives a private SQLite-backed novel library keyed by the immutable combination of tenant ID (`tid`) and object ID (`oid`). Email and display name are metadata only.

## Requirements

- A Linux host with Docker Engine and Docker Compose v2
- A DNS record for `novella.example.com` pointing to the host
- Public inbound TCP ports 80 and 443
- A single-tenant Microsoft Entra app registration in your organization's tenant
- Node.js 24 or newer for development outside Docker
- About 768 MiB of additional memory for the default LanguageTool limit (its Java heap defaults to 256–512 MiB)

## 1. Configure Microsoft Entra ID

In the Entra admin center, open the app registration and configure the following:

1. Leave **Supported account types** set to accounts in this organizational directory only.
2. Under **Authentication**, add these **Web** redirect URIs:

   ```text
   https://novella.example.com/auth/entra/callback
   https://novella.example.com/
   ```

3. Create a client secret and copy its **Value** into the server's private `.env`. Do not use the secret ID and do not commit or log the value.
4. Do not enable implicit grant or hybrid flow. Novella uses authorization code flow with PKCE.
5. Do not add Microsoft Graph permissions. Novella requests only `openid profile email` and does not call Graph.
6. No optional token claims are required. The `profile` scope supplies `oid`; `tid` and `oid` determine library ownership.

Enable **Assignment required** on the Enterprise Application and assign the intended users or group when practical. Until then, any eligible user in the tenant can sign in and will receive a separate library.

## 2. Configure the environment

Copy the example and edit every placeholder:

```sh
cp .env.example .env
chmod 600 .env
```

Generate the session-signing secret:

```sh
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
ENTRA_REDIRECT_URI=https://novella.example.com/auth/entra/callback
ENTRA_POST_LOGOUT_REDIRECT_URI=https://novella.example.com/
```

Rotating `SESSION_SECRET` immediately signs out every session but does not affect database ownership or manuscript data.

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

`PROOFREADING_URL` is a server-only fixed configuration value, never a browser input. Keep it on the internal service URL. Set `PROOFREADING_ENABLED=false` to run Novella without the checker; writing, saving, browser spellcheck, preview, narration, and export continue to work.

The stack pins community-maintained [`erikvl87/languagetool` 6.8](https://hub.docker.com/r/erikvl87/languagetool/tags) by its multi-platform digest. [LanguageTool itself is LGPL-2.1-or-later](https://github.com/languagetool-org/languagetool#license). The image is [one of the community images listed by the upstream LanguageTool project](https://github.com/languagetool-org/languagetool#docker), runs as its unprivileged `languagetool` user, includes a `/v2/check` healthcheck, and [documents a default 256–512 MiB Java heap](https://github.com/Erikvl87/docker-languagetool#java-heap-size). Its startup script appends configuration inside `/LanguageTool` only when `langtool_*` variables are supplied, so this stack deliberately supplies none; the root filesystem can remain read-only and `/tmp` is a small tmpfs. Routine checker logs are reduced to errors with `deployment/languagetool-logback.xml`.

## 3. Import an existing JSON library

Complete this step before the owner first signs in, so sample records cannot conflict with existing novel IDs.

Find both immutable identifiers in the Entra admin center:

- Tenant ID: **Microsoft Entra ID → Overview → Tenant ID**
- Object ID: **Microsoft Entra ID → Users → owner@example.com → Object ID**

Back up the existing data and build the new image without starting it:

```sh
tar -czf novella-json-before-sqlite-$(date +%F).tar.gz data/
docker compose build novella
```

Import the current `data/catalog.json` and `data/novels/*.json` into the specified identity:

```sh
docker compose run --rm --no-deps novella npm run migrate:json -- \
  --tenant-id <tenant-guid> \
  --object-id <owner-object-guid> \
  --email owner@example.com \
  --name "Example Owner"
```

The importer:

- uses only tenant ID and object ID for ownership;
- stores the email and name only for display;
- imports all records in one SQLite transaction;
- is safe to rerun when database content is identical;
- refuses to overwrite a matching novel ID with different content;
- never changes or deletes the legacy JSON files.

If only the older `data/project.json` exists, it is imported as `legacy-project`.

## 4. Deploy

Validate and start the stack:

```sh
docker compose config --quiet
docker compose pull
docker compose up -d --build --remove-orphans
docker compose ps
```

Follow startup if needed:

```sh
docker compose logs -f traefik novella
```

Novella fails fast when authentication values are missing, the session secret is too short, or the database cannot be opened. Port 4173 is not published.

LanguageTool also has no published port and no Traefik labels. Only Novella can reach it through the dedicated `novella_proofreading` network, which Docker marks internal. The checker is not a startup dependency: if it is unhealthy or stopped, proofreading reports a temporary unavailable state while the rest of Novella remains usable.

## 5. Verify identity isolation

1. Sign in as `owner@example.com` and confirm the imported novels appear.
2. Open, edit, export, and refresh an imported novel.
3. Restart Novella and confirm the signed session and library remain available:

   ```sh
   docker compose restart novella
   ```

4. Sign out and confirm Entra logout returns to `/login`.
5. If another assigned account is available, sign in with it in a separate private window and confirm it receives samples but cannot see the imported library.

All catalog, read, update, export, and delete queries include the authenticated database user ID. A novel ID belonging to another user returns `404` rather than revealing its existence.

## Local development

Install dependencies and start without authentication:

```sh
npm install
npm run dev
```

Open `http://localhost:4173`. Authentication-disabled development uses a fixed local-only identity stored in `data/novella.sqlite`; it does not overlap with an Entra identity.

For local Entra testing, register:

```text
http://localhost:4173/auth/entra/callback
http://localhost:4173/
```

Create an ignored `.env.local` containing:

```dotenv
AUTH_REQUIRED=true
SESSION_SECRET=generate-a-separate-local-value-of-at-least-32-characters
DATABASE_FILE=./data/novella.sqlite
ENTRA_TENANT_ID=your-tenant-guid
ENTRA_CLIENT_ID=your-application-client-id
ENTRA_CLIENT_SECRET=your-client-secret-value
ENTRA_REDIRECT_URI=http://localhost:4173/auth/entra/callback
ENTRA_POST_LOGOUT_REDIRECT_URI=http://localhost:4173/
```

Then run:

```sh
node --env-file=.env.local server.js
```

## Backups

SQLite may use `-wal` and `-shm` companion files while Novella is running. For a simple consistent filesystem backup, briefly stop Novella before copying the database:

```sh
docker compose stop novella
cp data/novella.sqlite novella-sqlite-$(date +%F).sqlite
docker compose start novella
```

Store the backup and `.env` encrypted outside the host. Keep the original JSON backup until the SQLite migration has been verified and restored in a test environment.

## Operations

```sh
docker compose ps
curl -I https://novella.example.com/
curl -I https://novella.example.com/api/health
```

The root request should redirect to `/login`; the public health endpoint returns only `{"ok":true}`.

Check the private proofreader without publishing it:

```sh
docker compose ps languagetool
docker compose exec novella node -e "fetch('http://languagetool:8010/v2/check',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'language=en-US&text=This+are+a+test'}).then(r=>console.log(r.status))"
```

The command should print `200`. Do not include manuscript text in operational checks or logs.

Apply updates with:

```sh
git pull --ff-only
docker compose up -d --build --remove-orphans
```

Run automated tests with:

```sh
npm test
```

## Rollback

Do not delete the legacy JSON files or their backup during the initial rollout. To roll back before new SQLite-only edits are made:

1. Stop Novella.
2. Restore the preceding application revision and Compose configuration.
3. Restore the preceding `.env`.
4. Restore the JSON backup if necessary.
5. Redeploy the preceding revision and verify manuscript access.

If users have edited SQLite-backed novels after migration, preserve `novella.sqlite` before rollback and reconcile those changes rather than discarding the database.

## Security notes

- Never publish port 4173 directly.
- Keep `.env` mode `0600`; never commit secrets or the SQLite database.
- Library ownership uses only validated `tid` and `oid`; email is never an authorization key.
- Foreign keys and composite primary keys enforce user ownership in SQLite.
- Novella uses an `HttpOnly`, `SameSite=Lax`, `Secure` production session cookie.
- State-changing requests enforce same-origin checks; logout also uses a session-bound CSRF token.
- `openid-client` validates token signature, issuer, audience, state, nonce, and PKCE; Novella additionally requires the configured tenant and an object ID.
- The application requests no refresh token and stores no Entra tokens in SQLite or its session cookie.
- Run only one Novella replica while using the synchronous embedded SQLite connection.
- Proofreading text is sent only from Novella to the private checker for the duration of a request. Neither service is configured to persist it, routine checker logging is disabled, responses are bounded, and upstream errors are sanitized.
- The pinned checker image is a community image rather than an official LanguageTool image. Review its release, digest, Dockerfile, license, and security posture before upgrades; update the version and digest together.
