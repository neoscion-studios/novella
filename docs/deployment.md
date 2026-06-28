# Private internet deployment

This deployment runs Novella behind Traefik and authentik. Traefik is the only service listening on the host network. Novella, PostgreSQL, and authentik's internal services are reachable only through Docker networks.

The stack uses authentik's embedded outpost with single-application forward auth. No separate proxy outpost or Redis service is required.

## Requirements

- A Linux host with Docker Engine and Docker Compose v2
- At least 2 CPU cores and 2 GB RAM
- Two DNS records pointing to the host, such as `novella.example.com` and `auth.example.com`
- Public inbound TCP ports 80 and 443
- A private Git repository or another secure way to copy the application to the host

Traefik uses the HTTP-01 Let's Encrypt challenge. Both DNS names must resolve to the host, and port 80 must remain reachable for certificate renewal.

## 1. Configure the environment

Copy the example and edit every placeholder:

```sh
cp .env.example .env
chmod 600 .env
```

Generate the two secrets independently:

```sh
openssl rand -base64 36 | tr -d '\n'
openssl rand -base64 60 | tr -d '\n'
```

Paste the first value into `PG_PASS` and the second into `AUTHENTIK_SECRET_KEY`. Do not change the authentik secret after installation; doing so invalidates active sessions.

## 2. Validate and start the stack

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

The Traefik dashboard is disabled. PostgreSQL has no published port, and Novella has no direct published port.

## 3. Initialize authentik

Open the following URL, including the final slash:

```text
https://auth.example.com/if/flow/initial-setup/
```

Replace the hostname with `AUTHENTIK_HOST`. Set a strong password for the default `akadmin` account. Configure a passkey or another MFA method from the authentik user interface before relying on this deployment remotely.

## 4. Protect Novella

In the authentik Admin interface:

1. Go to **Applications → Applications** and choose **Create with provider**.
2. Name the application `Novella` and use the slug `novella`.
3. Choose **Proxy Provider**.
4. Select **Forward auth (single application)**.
5. Set **External host** to `https://<NOVELLA_HOST>` with no trailing path.
6. Use the default provider authorization flow unless you have a custom flow.
7. In the binding step, bind your user directly—or bind a dedicated `Novella Users` group containing your user. Without a binding, authentik permits every authenticated user by default.
8. Submit the application and provider.
9. Go to **Applications → Outposts**, edit **authentik Embedded Outpost**, add the Novella application, and save.

The Compose labels already route `/outpost.goauthentik.io/` to the embedded outpost and send every other Novella request through authentik's forward-auth endpoint.

Open `https://<NOVELLA_HOST>` in a private browser window. You should be redirected to authentik, denied if the account lacks the application binding, and returned to Novella after successful authentication.

To sign out of the Novella provider:

```text
https://<NOVELLA_HOST>/outpost.goauthentik.io/sign_out
```

## Storage and backups

Novella uses the host's `./data` directory. Its catalog and one-file-per-novel storage survive container replacement. Back up the entire directory:

```sh
tar -czf novella-data-$(date +%F).tar.gz data/
```

authentik stores configuration, users, policies, and sessions in PostgreSQL. Back it up separately:

```sh
docker compose exec -T postgresql pg_dump -U authentik -d authentik > authentik-$(date +%F).sql
```

Also preserve `.env`; without `AUTHENTIK_SECRET_KEY`, restored sessions and encrypted configuration may become unusable. Store backups encrypted and outside the Docker host. Periodically test restoring both the novel directory and PostgreSQL dump.

## Operations

Check service health:

```sh
docker compose ps
curl -I https://<NOVELLA_HOST>
```

An unauthenticated `curl` request should receive an authentik redirect rather than Novella content.

Apply an application update:

```sh
git pull --ff-only
docker compose up -d --build
```

authentik and Traefik versions are intentionally pinned. Review their release notes, change the corresponding image tag, then run `docker compose pull && docker compose up -d` for deliberate upgrades.

## Security notes

- Never publish port 4173, 5432, or 9000 from this Compose project.
- Keep the host firewall limited to SSH, HTTP, and HTTPS.
- The Traefik Docker socket mount is read-only, but access to the socket is still sensitive. Keep the Traefik container and host patched.
- The authentik worker does not mount the Docker socket because this setup uses the embedded outpost. Add that capability only if you later choose authentik-managed external outposts.
- Run only one Novella replica while it uses JSON files for storage.
