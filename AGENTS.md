# AGENTS.md

## Project overview

Novella is a small, local-first novel-writing web application. The backend is CommonJS Node.js using the built-in HTTP server and synchronous SQLite; the frontend is dependency-free HTML, CSS, and browser JavaScript. There is no compilation or bundling step.

Use Node.js 24 or newer.

## Repository map

- `server.js`: HTTP routing, project validation, Markdown export, narration proxy, and app composition.
- `auth.js`: optional local mode and Microsoft Entra OIDC/session/CSRF behavior.
- `storage.js`: SQLite schema and user-scoped novel persistence.
- `legacy-import.js` and `scripts/migrate-json-to-sqlite.js`: non-destructive JSON migration.
- `public/`: browser UI, styles, and safe Markdown renderer.
- `test/`: Node test-runner coverage for server, auth/isolation, and migration.
- `data/samples/`: immutable templates copied into new user libraries.
- `docs/`: reconstructed product specification and deployment documentation.
- `compose.yaml` and `Dockerfile`: hardened private deployment behind the separately managed shared Caddy edge.

## Common commands

```sh
npm install
npm start
npm run dev
npm test
npm run migrate:json -- --tenant-id <guid> --object-id <guid> [--email <email>] [--name <name>]
```

The app defaults to `http://127.0.0.1:4173`. Local development does not require authentication unless `AUTH_REQUIRED=true` is configured.

## Change guidelines

- Preserve the build-free architecture unless a task explicitly calls for a tooling change.
- Keep runtime dependencies minimal; prefer Node and browser platform APIs already used by the project.
- Use CommonJS in server-side files and the existing plain-script pattern in `public/`.
- Keep API failures JSON-formatted and consistent with existing status semantics.
- Pass all novel operations through the storage layer with the current identity. Never look up a novel by ID without user ownership in the same operation.
- Continue returning `404` for cross-user access so resource existence is not disclosed.
- Treat `(tenantId, objectId)` as the only durable Entra identity key. Email and display name are metadata, not authorization inputs.
- Never expose the session secret, Entra client secret, ElevenLabs API key, provider tokens, stack traces, or sensitive upstream responses.
- Apply same-origin/CSRF protections to every new state-changing authenticated route.
- Keep `/api/health` public and minimal; do not add database, identity, or configuration details to it.
- Validate and normalize data at the server boundary. Preserve the 5 MiB request limit unless requirements explicitly change.
- Preserve Markdown export rules: H1 book title, optional italic byline, H2 chapters, no scene planning metadata, scene separators, and heading demotion outside code fences.
- Treat `data/samples/` as immutable templates. A user's edits must affect only their database records.
- Keep legacy migration non-destructive, transactional, idempotent for identical data, and conflict-rejecting for different data with the same novel ID.
- Do not commit `.env` files, credentials, `data/novella.sqlite`, WAL/SHM files, or other runtime user data.

## Frontend conventions

- Maintain the calm, accessible workspace and existing Manuscript/Characters/Locations navigation.
- Preserve keyboard shortcuts, focusability, labels, save-status feedback, and confirmation for destructive actions.
- Escape user content before inserting HTML. Extend `public/markdown.js` deliberately and add security-focused tests for new Markdown behavior.
- Continue debounced autosave and the pending-save unload warning.
- When changing ordering behavior, support scenes moving both within and between chapters and persist the resulting array order.
- Avoid exposing narration configuration beyond the safe fields already returned by `/api/tts/config`.

## Tests and verification

- Run `npm test` for every functional change.
- Add or update tests alongside behavior changes. Prefer injected paths, stores, OIDC clients, and fetch implementations rather than real external services.
- Use temporary directories for persistence tests; do not write tests against repository `data/`.
- For storage/auth changes, test both the intended user and a second identity, including read, update, delete, and export paths.
- For schema or migration changes, verify fresh initialization, existing database compatibility, idempotent import, conflict handling, and preservation of legacy inputs.
- For deployment changes, also run `docker compose config --quiet` when Docker/Compose is available.

## Documentation expectations

- Update `README.md` for user-visible local behavior or commands.
- Update `docs/deployment.md`, `.env.example`, and Compose configuration together when production environment variables, authentication, storage, backup, or proxy behavior changes.
- Update `docs/SPEC.md` when product requirements or acceptance criteria materially change; clearly label later decisions rather than rewriting history ambiguously.

