# Novella — Dedicated Service Identity

**Status:** Local implementation specification. Do not deploy or change production accounts.

## Goal

Prevent the Novella container's default UID/GID 1000 from sharing numeric ownership with the Web host's privileged break-glass account. Preserve that host account and its recovery role.

On the Web host, UID 1000 is the break-glass administrator, UID 1001 is `ksmith`, and UID 1002 is `deploy`. Do not modify any of these accounts.

## Requirements

1. Support configurable container runtime identity through `NOVELLA_UID` and `NOVELLA_GID` in root `compose.yaml` (for example, `user: "${NOVELLA_UID:-1000}:${NOVELLA_GID:-1000}"`). These are *runtime* credentials, not image build arguments. Keep the root Dockerfile unchanged unless tests establish a compelling need.
2. On production Web, create a dedicated unprivileged **host** service account and group named `novella` with system-assigned numeric IDs, no interactive login and no sudo or Docker-group membership. Use `id -u novella` and `id -g novella` to populate production `.env`; never assume specific IDs or use UID 1000 there.
3. Give the host `novella` identity write access **only** to the SQLite data directory (`./data` mounted at `/app/data`). Do not recursively chown the source tree, Dockerfile, Compose file, or `.env`. Keep secrets restricted to the deployment administrator.
4. Ensure the application works when its runtime UID/GID do not exist as named entries in the container's `/etc/passwd`. Preserve read-only root filesystem, non-root execution, SQLite persistence, and all existing security settings. Do not change LanguageTool's user or its isolated network.
5. Update `.env.example`, `docs/deployment.md`, and `AGENTS.md` with the runtime identity convention, host account creation example, data ownership/permissions, and local-development defaults. Do not store real credentials or production data in Git.
6. Add or adjust regression tests for configurable Compose runtime identity. Run `npm test`, `docker compose config --quiet`, and a disposable-container SQLite write/restart/read test using a non-1000 numeric UID/GID. Report any tests that cannot run.

## Acceptance criteria

- Web can run Novella as the dedicated host `novella` UID/GID, without granting it sudo or Docker access.
- The container does not need host UID 1000 to write its database.
- The application still builds and starts via the standard `docker compose up -d --build`.
- No changes to application behavior, schema, production accounts, DNS, or deployed services.

**Codex task:** Implement this specification in the current local migration branch. Keep changes minimal; test and summarize. Do not commit, push, merge, or deploy.
