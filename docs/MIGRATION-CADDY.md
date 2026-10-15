# Novella — Shared Caddy Web Migration

**Target:** `web.neoscion.com`  
**Public URL:** `https://novella.neoscion.com`  
**Status:** Implementation specification; no production changes authorized.

## Objective

Replace Novella's standalone Traefik deployment with the shared Caddy reverse proxy managed separately by Neoscion Studios at `/opt/web-edge`. Preserve application functionality, Entra authentication, SQLite manuscripts and dictionaries, LanguageTool proofreading, ElevenLabs integration, and existing hardening.

## Architecture

```text
Browser → Cloudflare → Web host → shared Caddy (Docker web network)
                                    └─ novella:4173
                                         ├─ SQLite at /app/data/novella.sqlite
                                         └─ LanguageTool on private internal network
```

Novella must not start its own proxy, publish HTTP/HTTPS ports, manage TLS certificates, or mount the Docker socket.

## Engineering convention

- Exactly one root `Dockerfile` and one root `compose.yaml`.
- Deploy the entire application with `docker compose up -d --build`.
- Do not introduce Compose overlays, secondary Dockerfiles, or special deployment procedures.
- Rename `compose.yml` to `compose.yaml`.

## Compose changes

1. Remove the `traefik` service, Traefik labels, ACME/certificate volume, published 80/443 ports, and Traefik-specific network.
2. Keep the existing `novella` and `languagetool` services, their environment configuration, resource limits, health checks, and hardening (non-root application, read-only filesystem, dropped capabilities, tmpfs, and `no-new-privileges`).
3. Connect Novella to the existing **external** Docker network `web` (network name `web`); assign a collision-resistant alias such as `novella-app`. Do not publish port 4173.
4. Connect Novella and LanguageTool to a dedicated `proofreading` network with `internal: true`. LanguageTool must not join `web` or publish any ports.
5. Preserve the existing `./data:/app/data` bind mount and `DATABASE_FILE=/app/data/novella.sqlite`. Do not change database schema, migrate user data, or create sample data as part of this conversion.
6. Preserve the LanguageTool image pin/digest and private service URL. Avoid unrelated dependency upgrades.
7. Do not modify the existing root Dockerfile unless genuinely necessary.

## Shared Caddy integration

Do **not** edit or deploy `/opt/web-edge` from this repository. Document this example for the Web operator to install as `/opt/web-edge/sites/novella.neoscion.com.caddy`:

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

Confirm the actual shared-network alias is unique and matches the Compose file. Align headers with existing Web Edge conventions without weakening authentication or CSRF protections. The public hostname remains unchanged.

## Authentication and secrets

- Preserve `AUTH_REQUIRED=true`, `SESSION_SECRET`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `ENTRA_REDIRECT_URI`, and `ENTRA_POST_LOGOUT_REDIRECT_URI`.
- Keep `https://novella.neoscion.com/auth/entra/callback` as the callback. No second auth layer in Caddy.
- Check HTTPS forwarding, secure session cookies, origin checks, and CSRF behavior behind Caddy; never trust arbitrary forwarded headers.
- Preserve ElevenLabs and proofreading settings.
- Remove Traefik-only `ACME_EMAIL` and obsolete `NOVELLA_HOST` if no longer used.
- Do not commit secrets or production data. Update `.env.example` with safe placeholders.

## Data protection and cutover (documentation only)

The production database contains manuscripts, characters, locations, and custom dictionaries. The GitHub checkout does **not** contain production data.

1. Identify the actual Vultr Compose directory, `data/` mount, SQLite file, and any WAL/SHM companions; verify current configuration before assuming repository defaults.
2. Arrange a write-free window; stop the old Novella application before taking a consistent SQLite backup (or use SQLite's online backup API correctly). Preserve a separate off-host copy and the encrypted production `.env`.
3. Restore the backup into the new host's bind-mounted data directory. Ensure it is writable by the container's existing `node` UID/GID; avoid broad world-writable permissions.
4. Verify the restored database's integrity and ownership, and test manuscript access, edit, export, dictionaries, Entra login/logout, narration configuration, and proofreading.
5. Switch DNS only after successful verification. Avoid simultaneous writable production instances. Keep the old VM available for rollback until validation and backups are complete.
6. Never delete, overwrite, or reinitialize the production database automatically.

## Documentation updates

Update `README.md`, `AGENTS.md`, `docs/deployment.md`, `.env.example`, and the root Compose file. Replace active Traefik deployment instructions with shared-Caddy instructions, including:

- Prerequisite external `web` Docker network (create locally with `docker network create web` if absent).
- How to configure the separate Caddy site snippet and verify upstream reachability.
- Required host directory ownership and persistent data handling.
- Safe SQLite backup/restore, WAL awareness, validation, and rollback.
- Entra callback and Cloudflare/DNS cutover checks.
- LanguageTool isolation and health checks.
- The standard single-command deployment procedure.

## Verification

- Run `npm test`.
- Run `docker compose config --quiet` with placeholder values where necessary.
- Run `docker compose up -d --build` in a local test environment with the external `web` network available; verify app health and persistence across restart.
- Verify Novella is reachable on port 4173 from a container on `web`, but has **no host-published ports**.
- Verify LanguageTool is reachable only through the private proofreading network and remains functional.
- Confirm no active Traefik services, labels, ports, or certificate dependencies remain.
- Automated tests must not require live Entra credentials or access production data.
- If local runtime testing is not possible, report precisely what was not verified.

## Scope and deliverable

Keep changes minimal and deployment-focused. Do not rewrite the app, change identity or storage semantics, add PostgreSQL/Kubernetes, modify production infrastructure, change DNS, or push/deploy without approval.

**Codex task:** Read `AGENTS.md` and this specification. Implement the conversion locally, run tests and Compose validation, then report changed files, results, and outstanding questions. Do not commit, push, or deploy.
