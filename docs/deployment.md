# Private internet deployment

This deployment runs Novella behind Traefik with application-owned authentication. Microsoft Entra ID is the primary OpenID Connect provider. Authentik remains available as a temporary second sign-in option during migration.

Traefik is the only service listening on the host network. Novella, PostgreSQL, and Authentik's internal services remain reachable only through Docker networks.

## Requirements

- A Linux host with Docker Engine and Docker Compose v2
- At least 2 CPU cores and 2 GB RAM
- DNS records for Novella and the temporary Authentik host
- Public inbound TCP ports 80 and 443
- A single-tenant Microsoft Entra app registration in the Neoscion Studios tenant
- A private Git repository or another secure way to copy the application to the host

Traefik uses the HTTP-01 Let's Encrypt challenge. Both DNS names must resolve to the host while Authentik is retained, and port 80 must remain reachable for certificate renewal.

## 1. Configure Microsoft Entra ID

In the Entra admin center, open the app registration and configure the following:

1. Leave **Supported account types** set to accounts in the Neoscion Studios directory only.
2. Under **Authentication**, add a **Web** redirect URI:

   ```text
   https://novella.neoscion.com/auth/entra/callback
   ```

3. Register the post-logout destination as another Web redirect URI:

   ```text
   https://novella.neoscion.com/
   ```

4. Create a client secret and copy its **Value** into the server's private `.env`. Do not use the secret ID and do not commit or log the value.
5. Do not enable implicit grant or hybrid flow. Novella uses authorization code flow with PKCE.
6. Do not add Microsoft Graph permissions. Novella requests only `openid profile email` and does not call Graph.
7. No optional token claims are required. The `profile` scope supplies the stable `oid` claim; `tid` and `oid` are used for identity, while names and email-like claims are display-only.

For the safest tenant-wide authorization, enable **Assignment required** on the Enterprise Application and assign only the intended user or group. Until that is enabled, any eligible user in the tenant may be able to sign in. Novella still rejects tokens whose `tid` differs from `ENTRA_TENANT_ID`.

## 2. Configure the environment

Copy the example and edit every placeholder:

```sh
cp .env.example .env
chmod 600 .env
```

Generate all four secrets independently:

```sh
openssl rand -base64 36 | tr -d '\n'
openssl rand -base64 60 | tr -d '\n'
openssl rand -base64 48 | tr -d '\n'
openssl rand -base64 48 | tr -d '\n'
```

Use them for `PG_PASS`, `AUTHENTIK_SECRET_KEY`, `SESSION_SECRET`, and `AUTH_PROXY_SECRET`, respectively. Do not change `AUTHENTIK_SECRET_KEY` while Authentik is retained. Rotating `SESSION_SECRET` is safe but immediately signs out every Novella session.

Configure these Entra values:

```dotenv
AUTH_REQUIRED=true
AUTHENTIK_LOGIN_ENABLED=true
NOVELLA_MIDDLEWARES=security-headers@docker
ENTRA_TENANT_ID=your-tenant-guid
ENTRA_CLIENT_ID=your-application-client-id
ENTRA_CLIENT_SECRET=your-client-secret-value
ENTRA_REDIRECT_URI=https://novella.neoscion.com/auth/entra/callback
ENTRA_POST_LOGOUT_REDIRECT_URI=https://novella.neoscion.com/
```

`SESSION_SECRET` signs application sessions and short-lived OIDC transaction cookies. `AUTH_PROXY_SECRET` authenticates only the internal Traefik-to-Novella Authentik handoff. Neither value should be reused as the Entra client secret.

### Optional: ElevenLabs narration

To enable the scene **Listen** button, add the ElevenLabs credentials to `.env`:

```dotenv
ELEVENLABS_API_KEY=your-api-key
ELEVENLABS_VOICE_ID=your-voice-id
ELEVENLABS_MODEL_ID=eleven_flash_v2_5
ELEVENLABS_ENABLE_LOGGING=false
```

The key is passed only to Novella and is never returned to the browser. With logging disabled, Novella requests ElevenLabs zero-retention mode. Scene text still leaves the server for speech generation.

## 3. Validate and deploy

Before changing the running stack, back up `data/`, `.env`, and the Authentik database as described below. Then run:

```sh
docker compose config --quiet
docker compose pull
docker compose up -d --build
docker compose ps
```

Follow startup if needed:

```sh
docker compose logs -f traefik authentik-server authentik-worker novella
```

Novella fails fast when required authentication values are missing or secrets are too short. PostgreSQL and Novella have no published ports.

## 4. Verify both providers

Use separate private browser windows for each flow:

1. Open `https://novella.neoscion.com/` and confirm it redirects to `/login`.
2. Choose **Sign in with Microsoft** and confirm Entra returns through `/auth/entra/callback`.
3. Confirm the existing novels, characters, and locations remain visible and edits persist after refresh.
4. Sign out. Confirm the local cookie is cleared, Entra logout runs, and Novella returns to the login page.
5. Choose **Sign in with Authentik** and complete the existing Authentik flow.
6. Confirm it opens the same shared workspace and that Authentik logout still works.
7. Repeat the Microsoft flow after restarting only the Novella container to verify signed-cookie session persistence:

   ```sh
   docker compose restart novella
   ```

The application stores provider-specific stable identifiers in the signed session but does not assign manuscripts to users. Both providers therefore open the same existing workspace; no email-based account matching or data migration occurs.

## Local Entra testing

Add these two Web redirect URIs to the same app registration if local testing is desired:

```text
http://localhost:4173/auth/entra/callback
http://localhost:4173/
```

Create an ignored `.env.local` containing the Entra configuration plus:

```dotenv
AUTH_REQUIRED=true
AUTHENTIK_LOGIN_ENABLED=false
SESSION_SECRET=generate-a-separate-local-value-of-at-least-32-characters
ENTRA_REDIRECT_URI=http://localhost:4173/auth/entra/callback
ENTRA_POST_LOGOUT_REDIRECT_URI=http://localhost:4173/
```

Start Novella without placing credentials on the command line:

```sh
node --env-file=.env.local server.js
```

Then open `http://localhost:4173`. Authentik login is intentionally hidden locally unless the Traefik/Authentik stack is also running.

Run automated tests with the repository's supported Node runtime:

```sh
npm test
```

The OIDC tests use a fake provider and never require or print a real client secret.

## Storage and backups

Novella uses the host's `./data` directory. Back up the entire directory:

```sh
tar -czf novella-data-$(date +%F).tar.gz data/
```

While Authentik remains, back up its PostgreSQL database separately:

```sh
docker compose exec -T postgresql pg_dump -U authentik -d authentik > authentik-$(date +%F).sql
```

Also preserve `.env` in encrypted storage. Periodically test restoring both the novel directory and PostgreSQL dump.

## Operations

Check service health and the unauthenticated redirect:

```sh
docker compose ps
curl -I https://novella.neoscion.com/
curl -I https://novella.neoscion.com/api/health
```

The first request should redirect to `/login`; the health endpoint remains public for container monitoring and returns only `{"ok":true}`.

Apply an application update:

```sh
git pull --ff-only
docker compose up -d --build
```

## Rollback

The fastest authentication rollback retains the updated application but restores the previous proxy-only Authentik gate. In `.env`, set:

```dotenv
AUTH_REQUIRED=false
NOVELLA_MIDDLEWARES=authentik@docker,security-headers@docker
```

Then apply the configuration:

```sh
docker compose up -d
```

An unauthenticated request should again redirect directly to Authentik. Restore `AUTH_REQUIRED=true` and `NOVELLA_MIDDLEWARES=security-headers@docker` to retry the dual-provider phase.

For a full code rollback, redeploy the preceding known-good commit and its Compose configuration. Do not delete Authentik containers, volumes, DNS, or database backups until Microsoft login, callback validation, session persistence, both logout paths, and production redirects have all been verified.

## Security notes

- Never publish ports 4173, 5432, or 9000.
- Keep `.env` mode `0600`; never commit any of its secrets.
- Novella uses an `HttpOnly`, `SameSite=Lax`, `Secure` production cookie with an eight-hour default lifetime.
- State-changing requests require an exact `Origin` match with `ENTRA_REDIRECT_URI`'s origin.
- Redirect URLs come from configuration rather than untrusted forwarded host or protocol headers.
- Token signature, issuer, audience, state, nonce, and PKCE checks are handled by `openid-client`; Novella additionally requires the configured `tid` and an `oid`.
- The application requests no refresh token and stores no Entra tokens in its session cookie.
- Keep the host firewall limited to SSH, HTTP, and HTTPS.
- Run only one Novella replica while it uses JSON files for storage.
