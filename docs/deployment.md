# Private internet deployment

This deployment runs Novella behind Traefik with application-owned Microsoft Entra ID authentication. Traefik is the only service listening on the host network, and Novella is reachable only through the private Docker network.

## Requirements

- A Linux host with Docker Engine and Docker Compose v2
- A DNS record for `novella.neoscion.com` pointing to the host
- Public inbound TCP ports 80 and 443
- A single-tenant Microsoft Entra app registration in the Neoscion Studios tenant
- A private Git repository or another secure way to copy the application to the host

Traefik uses the HTTP-01 Let's Encrypt challenge, so port 80 must remain reachable for certificate renewal.

## 1. Configure Microsoft Entra ID

In the Entra admin center, open the app registration and configure the following:

1. Leave **Supported account types** set to accounts in the Neoscion Studios directory only.
2. Under **Authentication**, add these **Web** redirect URIs:

   ```text
   https://novella.neoscion.com/auth/entra/callback
   https://novella.neoscion.com/
   ```

3. Create a client secret and copy its **Value** into the server's private `.env`. Do not use the secret ID and do not commit or log the value.
4. Do not enable implicit grant or hybrid flow. Novella uses authorization code flow with PKCE.
5. Do not add Microsoft Graph permissions. Novella requests only `openid profile email` and does not call Graph.
6. No optional token claims are required. The `profile` scope supplies the stable `oid` claim; `tid` and `oid` identify the user, while names and email-like claims are display-only.

For the safest tenant-wide authorization, enable **Assignment required** on the Enterprise Application and assign only the intended user or group. Until that is enabled, any eligible user in the tenant may be able to sign in. Novella still rejects tokens whose `tid` differs from `ENTRA_TENANT_ID`.

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

Configure authentication:

```dotenv
AUTH_REQUIRED=true
SESSION_SECRET=replace-with-the-generated-value
ENTRA_TENANT_ID=your-tenant-guid
ENTRA_CLIENT_ID=your-application-client-id
ENTRA_CLIENT_SECRET=your-client-secret-value
ENTRA_REDIRECT_URI=https://novella.neoscion.com/auth/entra/callback
ENTRA_POST_LOGOUT_REDIRECT_URI=https://novella.neoscion.com/
```

`SESSION_SECRET` signs application sessions and short-lived OIDC transaction cookies. Rotating it is safe but immediately signs out every Novella session.

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

Back up `data/` and `.env`, then run:

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

Novella fails fast when required authentication values are missing or the session secret is too short. Novella has no published application port.

## 4. Verify authentication

Use a private browser window:

1. Open `https://novella.neoscion.com/` and confirm it redirects to `/login`.
2. Choose **Sign in with Microsoft** and confirm Entra returns through `/auth/entra/callback`.
3. Confirm the existing novels, characters, and locations remain visible and edits persist after refresh.
4. Restart Novella and confirm the signed session remains valid:

   ```sh
   docker compose restart novella
   ```

5. Sign out and confirm the local cookie is cleared, Entra logout runs, and Novella returns to the login page.

The application stores the stable Entra tenant and object identifiers in the signed session but does not assign manuscripts to individual users. Existing data therefore remains in the same shared workspace; no email-based account matching or data migration occurs.

## Local Entra testing

Add these Web redirect URIs to the app registration if local testing is desired:

```text
http://localhost:4173/auth/entra/callback
http://localhost:4173/
```

Create an ignored `.env.local` containing:

```dotenv
AUTH_REQUIRED=true
SESSION_SECRET=generate-a-separate-local-value-of-at-least-32-characters
ENTRA_TENANT_ID=your-tenant-guid
ENTRA_CLIENT_ID=your-application-client-id
ENTRA_CLIENT_SECRET=your-client-secret-value
ENTRA_REDIRECT_URI=http://localhost:4173/auth/entra/callback
ENTRA_POST_LOGOUT_REDIRECT_URI=http://localhost:4173/
```

Start Novella without placing credentials on the command line:

```sh
node --env-file=.env.local server.js
```

Then open `http://localhost:4173`.

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

Also preserve `.env` in encrypted storage and periodically test restoring the novel directory.

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
docker compose up -d --build --remove-orphans
```

## Rollback

Keep the preceding application image or Git revision and a copy of its Compose configuration until the Entra flow is verified. If deployment fails:

1. Restore that revision and its Compose configuration.
2. Restore the previous `.env` from encrypted backup.
3. Run `docker compose up -d --build --remove-orphans`.
4. Confirm the prior authentication gate and manuscript access before investigating the failed release.

Do not delete manuscript data during an authentication rollback.

## Security notes

- Never publish port 4173 directly.
- Keep `.env` mode `0600`; never commit any of its secrets.
- Novella uses an `HttpOnly`, `SameSite=Lax`, `Secure` production cookie with an eight-hour default lifetime.
- State-changing API requests require an exact origin or same-origin browser signal. Logout also uses a session-bound CSRF token so native form submissions remain protected when a browser or proxy omits both headers.
- Redirect URLs come from configuration rather than untrusted forwarded host or protocol headers.
- Token signature, issuer, audience, state, nonce, and PKCE checks are handled by `openid-client`; Novella additionally requires the configured `tid` and an `oid`.
- The application requests no refresh token and stores no Entra tokens in its session cookie.
- Keep the host firewall limited to SSH, HTTP, and HTTPS.
- Run only one Novella replica while it uses JSON files for storage.
