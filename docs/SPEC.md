# Novella reconstructed product specification

## Status and evidence

This document reconstructs the specification Novella was most likely built from. It is not an original design document. The requirements below are inferred from `initialize.md`, the README and deployment guide, application code, automated tests, sample data, and Git history through commit `0f2a6ce`.

## Product intent

Novella is a calm, local-first workspace for drafting novels. It should keep a writer's manuscript structure and story-reference notes together, save work without a manual save workflow, and produce a clean Markdown manuscript. The core experience should run as a small self-hosted Node.js web application with no frontend build step.

## Core domain model

A novel contains:

- a title and author;
- an ordered list of chapters;
- an ordered list of scenes within each chapter;
- character reference cards; and
- location reference cards.

Each chapter has a stable ID, title, optional summary, and scenes. Each scene has a stable ID, internal title, synopsis, and Markdown content. Character and location records have stable IDs, a name, a role/type, and freeform description. Missing or malformed optional collections should normalize to empty arrays, and blank titles should receive useful defaults.

## Phase 1: local novel-writing workspace

### Manuscript organization

- Present Manuscript, Characters, and Locations as the primary workspace views.
- Let the writer edit the novel title and author.
- Let the writer add, rename, reorder, and delete chapters.
- Let the writer add, rename, reorder, move between chapters, and delete scenes.
- Use drag-and-drop for chapter and scene ordering.
- Keep scene titles and synopses as private planning metadata rather than exported manuscript text.
- Show scene word counts in the outline and editor.
- Require confirmation before destructive deletes.

### Scene editor

- Provide a focused editor for the selected scene with title, synopsis, and content.
- Accept Markdown scene content and provide Write and Preview modes.
- Provide toolbar actions for bold, italic, heading, blockquote, divider, and link markup.
- Support `Ctrl/Cmd+B`, `Ctrl/Cmd+I`, and `Ctrl/Cmd+K` shortcuts.
- Render Markdown safely: escape raw HTML and reject unsafe link schemes.
- Support headings, paragraphs, emphasis, links, blockquotes, lists, fenced code blocks, inline code, and thematic breaks in preview.
- Keep long scenes usable by allowing the editor region to scroll correctly.

### Story references

- Provide separate character and location libraries.
- Let writers create, edit, and delete reference cards in place.
- Store a name, role/type, and freeform notes for each reference.

### Persistence and feedback

- Automatically save edits after a short debounce rather than requiring a Save button.
- Indicate saving, saved, and failed states.
- Warn before leaving while a save is pending.
- Initially persist a single project as readable JSON on the local filesystem.
- Validate request bodies and cap JSON payloads at 5 MiB.

### Markdown export

- Export a UTF-8 `.md` file named from a slug of the novel title.
- Emit the novel title as an H1 and, when present, the byline as italic text.
- Emit chapter titles as H2 headings in manuscript order.
- Omit chapter summaries, scene titles, scene synopses, and empty scenes.
- Separate consecutive written scenes with `* * *`.
- Shift headings inside scene content down two levels so they do not collide with manuscript structure.
- Do not rewrite heading-like text inside fenced code blocks.

## Phase 2: multi-novel, samples, and private deployment

### Novel library

- Support multiple novels in one installation.
- Provide a selector to switch novels and controls to create or delete a novel.
- Remember the most recently active novel in the browser when it still exists.
- Update library metadata when title or author changes.
- Never allow deletion of the final remaining novel.
- Seed a fresh library with two substantial fictional examples when bundled sample data is available; otherwise create one blank novel.
- Copy samples into the library so editing them never changes the source fixtures.

### JSON storage layout (historical)

- Maintain a versioned catalog with novel metadata and timestamps.
- Store each complete novel in its own JSON file.
- Continue recognizing the original `data/project.json` as a legacy source.
- Write storage updates safely so an interrupted write does not leave a partially written JSON document.

### Private hosting

- Package the application in a non-root Node.js container.
- Supply a Docker Compose deployment behind Traefik with automatic HTTPS.
- Do not publish the application port directly in the production stack.
- Run the application container with a read-only root filesystem, dropped capabilities, `no-new-privileges`, and a writable mounted data directory.
- Expose a minimal unauthenticated health response at `/api/health`.
- Document configuration, deployment, verification, backups, operations, security, and rollback.

## Phase 3: optional ElevenLabs narration

- When server-side ElevenLabs credentials are configured, show a Listen control for the active scene.
- Convert Markdown scene content to suitable plain text before synthesis.
- Send synthesis requests through the server so the API key is never exposed to the browser.
- Use a configurable voice and model, defaulting to `eleven_flash_v2_5`.
- Respect the configured model's character limit and return clear errors for empty, oversized, unauthorized, rate-limited, or otherwise failed requests.
- Stream or return MPEG audio and let the user stop active playback.
- Request zero-retention behavior by default (`enable_logging=false`), while allowing explicit configuration.
- Hide narration controls entirely when narration is not configured.

## Phase 4: Microsoft Entra authentication and multi-user SQLite storage

### Authentication

- Keep authentication optional for local development and required for private internet deployment.
- Use single-tenant Microsoft Entra ID authorization-code flow with PKCE.
- Request only `openid profile email`; do not require Microsoft Graph access, refresh tokens, or implicit flow.
- Validate issuer/token processing through the OIDC client and enforce state, nonce, PKCE, configured tenant ID, and the presence of an object ID.
- Identify ownership solely by the immutable `(tenant ID, object ID)` pair. Treat email and display name as mutable presentation metadata only.
- Use signed, `HttpOnly`, `SameSite=Lax` session cookies, with `Secure` enabled in production.
- Keep OIDC transactions short-lived and sessions time-limited.
- Redirect unauthenticated page requests to `/login`, return `401` for protected API requests, and leave only login/authentication and health routes public.
- Perform provider logout and clear local session state. Protect logout with a session-bound CSRF token.
- Require same-origin state-changing requests and reject cross-site mutations.
- Fail startup when production authentication configuration is missing or unsafe.

### Multi-user persistence

- Store users, novels, and complete validated project documents in SQLite at a configurable path.
- Enable foreign keys and use WAL journaling.
- Enforce ownership in both schema constraints and every catalog/read/update/export/delete query.
- Return `404` for another user's novel so its existence is not disclosed.
- Give every first-time user an independent copy of the sample library (or a blank novel fallback).
- Keep local authentication-disabled development under a fixed local-only identity that cannot overlap an Entra identity.
- Support a single application replica while using the synchronous embedded SQLite design.

### Legacy migration

- Provide an explicit CLI migration from the catalog/per-novel JSON layout and the older single `project.json` layout.
- Require the destination owner's valid Entra tenant and object GUIDs.
- Import all records in one SQLite transaction while retaining original creation/update timestamps where available.
- Make identical reruns idempotent.
- Refuse to overwrite an existing matching novel ID when content differs.
- Never modify or delete legacy JSON files.
- Document backup and rollback precautions, including SQLite WAL/SHM considerations.

## API behavior

The application exposes these principal endpoints:

- `GET /api/health` returns only `{ "ok": true }`.
- `GET /api/auth/session` reports whether authentication is required and returns safe display identity and CSRF information when signed in.
- `GET /api/novels` returns the current user's ordered catalog.
- `POST /api/novels` creates a novel and returns its summary and project (`201`).
- `GET /api/novels/:id` returns one owned novel.
- `PUT /api/novels/:id` validates and saves one owned novel.
- `DELETE /api/novels/:id` deletes it unless it is the user's final novel (`409`).
- `GET /api/novels/:id/export` downloads its manuscript as Markdown.
- `GET /api/tts/config` reveals only safe narration capability/model information.
- `POST /api/tts` synthesizes the supplied scene through the configured provider.
- `GET /api/proofreading/config` returns only the safe enabled state, configured language, and text limit.
- `POST /api/proofreading/check` authorizes the supplied novel and scene for the current identity and checks the unsaved Markdown snapshot without saving it.
- `GET /api/proofreading/dictionaries?novelId=:id` returns the current user's author dictionary and the owned novel's dictionary.
- `POST /api/proofreading/dictionaries` adds one validated author- or novel-scoped word; `DELETE` removes one. Mutations use the same origin protections as other authenticated state changes.

Unknown API routes return JSON `404` responses. Invalid JSON returns `400`, oversized input returns `413`, and unexpected server failures do not expose secrets.

## Quality attributes and acceptance criteria

- Run on Node.js 24 or newer with `npm start`; use `npm run dev` for watch mode.
- Keep runtime dependencies minimal and use browser-native HTML, CSS, and JavaScript.
- Keep server modules testable by injecting storage, authentication/OIDC, filesystem paths, and `fetch` where needed.
- `npm test` must cover normalization, safe Markdown rendering, export hierarchy, persistence and novel lifecycle, sample seeding, narration proxy behavior, session integrity, Entra flow checks, CSRF/origin controls, cross-user isolation, and migration safety.
- Never commit secrets, runtime databases, SQLite sidecar files, or local environment files.

## Phase 5: bounded self-hosted proofreading (decision dated 2026-10-10)

- Keep the native Markdown textarea and its Write/Preview behavior; enable native browser spellcheck explicitly and do not introduce contenteditable, an overlay editor, or inline server-generated underlines.
- Offer user-triggered scene review and sequential chapter review through a provider-neutral server adapter backed initially by self-hosted LanguageTool.
- Project Markdown to checkable plain text while retaining an exact UTF-16 offset map. Skip fenced and inline code, URLs, link destinations, HTML tags, and Markdown delimiters. Suggestions crossing removed syntax are advisory and cannot be applied automatically.
- Present categories, excerpts, explanations, replacements, and review-scoped ignore actions. Never rewrite automatically or persist a dictionary in this phase.
- Bind every review to the exact novel, scene, and source snapshot. Accept only when identity, active context, offsets, and original text still match; use the textarea editing path and input event so autosave remains authoritative.
- Treat edits, scene/novel changes, and out-of-order responses as stale. A stale suggestion cannot mutate any manuscript.
- Run LanguageTool in a digest-pinned, unprivileged, read-only container on a dedicated internal Docker network with no host port or Traefik route. Bound requests, responses, concurrency, and timeouts; do not log or persist manuscript text.
- Support `en-US` initially through server configuration. Checker failure or disablement must not affect editing, saving, narration, preview, or export.
- Continuous/live review, inline decoration, and Literary Intelligence remain future work. Literary Intelligence is context-aware analysis and is not part of mechanical proofreading.

## Phase 6: author dictionaries and review improvements (decision dated 2026-10-10)

- Persist author-wide and novel-specific dictionary entries in separate, user-owned SQLite tables added by schema version 2. Existing novels migrate additively without document rewrites.
- Author entries apply to all novels owned by the same `(tenant ID, object ID)`. Novel entries apply only to one novel owned by that identity; cross-user and cross-novel access returns `404` under existing ownership semantics.
- Accept single Unicode words up to 80 code points, preserving NFC display spelling. Matching uses NFC and `en-US` case folding, is exact rather than substring-based, and permits internal apostrophes and hyphens. Each scope is limited to 500 entries.
- Suppress only normalized `spelling` findings whose complete matched source equals a dictionary entry. Grammar, punctuation, style, multiword findings, and longer related words remain visible.
- Allow direct dictionary entry, addition from eligible spelling findings, scoped viewing, and confirmed removal. Dictionary changes never modify manuscript text and explicitly refresh the current requested review when proofreading is available.
- Provide previous/next issue controls, selected-issue state, safe cross-scene navigation, and visible sequential chapter progress without replacing the native textarea.
- Retain exact snapshot/novel/scene guards, UTF-16 Markdown mappings, manual review initiation, private provider networking, and graceful unavailable behavior.
- Maintain a deliberately error-filled diagnostic fixture and record observed LanguageTool coverage separately from deterministic application tests. Missed provider findings are documented rather than synthesized.

