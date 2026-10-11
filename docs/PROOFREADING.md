# Novella proofreading — implementation specification

Status: Implemented (2026-10-10). This is a bounded proofreading feature, not the future Literary Intelligence system.

## Goal
Provide reliable, private spelling and grammar review sufficient for everyday fiction editing without a Grammarly subscription. Preserve authorial voice, existing Markdown scene editing, and the dependency-light architecture.

## Existing architecture and integration points
- CommonJS Node.js 24 HTTP server (`server.js`), no framework or build step.
- Plain browser JavaScript (`public/app.js`), CSS, and safe Markdown preview.
- The Write editor is a native `textarea.scene-content[data-scene-field="content"]`; Preview is rendered separately. Native textarea text cannot contain individually styled inline underlines. Do **not** claim that server findings can be underlined in the textarea without replacing or overlaying the editor.
- Scene content lives inside the per-user novel JSON stored in SQLite; chapter summaries, scene synopses, characters, and locations are existing metadata.
- Debounced full-project autosave and origin/session protections already exist.
- Compose uses Traefik and the `novella_proxy` network.

## Architectural contract
1. Keep the proofreading API provider-neutral. Define an internal adapter with `check({text, language}) -> normalized issues`; LanguageTool is the initial adapter. Do not expose LanguageTool-specific payloads to browser code.
2. Run LanguageTool in a separate, pinned, maintained container with its own JVM; no Java dependency, runtime, or client library inside Novella or on the host.
3. Place Novella and LanguageTool on a dedicated **internal** Docker network. No published LanguageTool ports, no Traefik route or external ingress, no browser-to-LanguageTool requests. Keep Novella's existing proxy connectivity.
4. Configure internal URL, enable flag, request timeout, and language via environment variables. Fail gracefully when disabled or unavailable. Local `npm start` works without Docker.
5. Choose and verify a maintained image/version and its license, writable paths, health behavior, and resource needs before pinning a digest. Do not blindly copy a third-party example image or assume read-only mode works.
6. Manuscript text sent for checking must not be persisted or logged by Novella or the checker. Disable unnecessary request logging and keep errors sanitized. Limit request sizes, response sizes, concurrency, and timeouts; never allow arbitrary upstream URLs from clients.
7. No AI or external cloud API in this phase. Future literary analysis uses separate context-aware services but may contribute to the same normalized suggestion UI.

## UI behavior — Phase 1
- Explicit `spellcheck="true"` on the scene content textarea; native browser spellcheck is available even if LanguageTool is down. Keep Write/Preview, formatting shortcuts, cursor behavior, focus, and autosave intact.
- Provide a calm, accessible `Proofread scene` action and a compact issue list/panel with categories, matched excerpt, explanation, replacements, and `Accept`, `Ignore`, `Ignore in scene` actions. Avoid automatic rewriting.
- Show a clear disabled/unavailable state; never block writing or saving.
- `Proofread chapter` checks its scenes in bounded sequential or limited-concurrency batches and groups findings by scene; navigate to a scene when reviewing an issue.
- Do **not** replace the textarea with contenteditable or add a rich editor just to underline issues. Phase 1 presents findings in the side panel and uses selection/focus to locate an issue. Native browser spellcheck supplies native underlines. A future inline annotation layer is a separate, tested decision.
- Review is user-triggered initially. A future optional live mode may use debounce and cancellation; do not add continuous remote checks by default.
- Support US English initially (`en-US`); expose a straightforward future language configuration path.
- Ignore state is scoped to the active scene/review unless explicitly persisted in a later phase. No global custom dictionary in Phase 1; document this as a follow-up rather than pretending it exists.
- Preserve existing Markdown syntax. For Phase 1, check a **plain-text projection** of scene Markdown with a robust offset map back to original UTF-16 textarea offsets. Skip markup delimiters, fenced code, URLs, and other syntax. If reliable mapping cannot be established for an issue, display it as advisory only with no one-click replacement. Never apply offsets from a transformed string directly to source Markdown.

## API
- Add an authenticated, same-origin protected `POST /api/proofreading/check` route accepting `{ novelId, sceneId, text, language? }`. Authorize the novel through existing identity-scoped storage before processing; verify scene belongs to that novel. Apply existing origin/CSRF expectations for POST requests.
- Bound text length and request body size; reject malformed inputs with existing JSON error semantics. The request text is the current unsaved editor snapshot (to avoid forcing a save before checking); do not overwrite stored manuscript during analysis.
- Return normalized `{ issues: [{ id, category, message, shortMessage?, start, end, original, replacements: [{value}], ruleId?, provider }], status }`. Offsets must be documented as UTF-16 indices into the **exact source Markdown** sent by the client, with exclusive end.
- The server adapter translates LanguageTool's match offsets to the normalized source offsets via the projection map. Reject invalid/out-of-bounds spans and sanitize provider responses. Return a safe unavailable status on checker timeouts/failures.
- Keep provider configuration and upstream errors private.

## Applying suggestions safely
- Attach each review to novel ID, scene ID, and exact source snapshot/hash. Before applying a replacement, verify the active novel and scene still match, and that the targeted original substring at the stored offset still matches. If content changed, invalidate or rerun review rather than risking a wrong edit.
- Apply **only** the selected replacement through the textarea editing pathway (e.g., `setRangeText`), dispatch the existing input event to update the model and autosave, preserve undo/caret behavior where possible, and refresh remaining findings.
- Never silently edit text. Ignore and navigation actions must not mutate manuscript content.
- Stale responses must not overwrite newer review results when switching novels/scenes or editing text.

## Future extension, not this phase
- Personal dictionary (including character names and invented terms), persisted per user or novel.
- Optional live review with debouncing, incremental checking, and caching.
- Inline decorations if justified by an editor architecture change.
- Literary Intelligence: contextual continuity, pacing, arcs, foreshadowing, reader-vs-author knowledge, and evidence-linked observations. These must remain separate from mechanical proofreading, although both can use a common suggestion presentation contract.

## Delivery sequence
1. Introduce the adapter, Markdown projection/offset mapping, protected API, and tests.
2. Add the isolated Compose service/network/configuration, health/failure behavior, deployment documentation, and tests.
3. Add Proofread scene, issue panel, safe accept/ignore, and accessible interaction.
4. Add bounded Proofread chapter and cross-scene navigation.
5. Update README, `docs/deployment.md`, `.env.example`, and `docs/SPEC.md`; run `npm test` and `docker compose config --quiet` when available.

## Acceptance tests
- Plain text: misspelling and subject–verb agreement are detected, categorized, and correctable.
- Markdown: punctuation and emphasis syntax survive edits; no incorrect replacement in links, URLs, or fenced code; Unicode/emoji offset cases are safe.
- Fictional names and intentional fragments can be ignored without forced rewriting.
- No edits occur until Accept; Accept preserves unrelated characters and triggers autosave.
- Modified text, scene switches, novel switches, out-of-order responses, and stale offsets never cause edits in the wrong location.
- A second authenticated user cannot request another user's novel; unauthorized/invalid requests fail without leaking novel existence.
- Checker stopped, misconfigured, timed out, or returning malformed data: Novella remains usable; browser spellcheck, autosave, and export work.
- LanguageTool has no published host port; the container is isolated from the public proxy.
- Existing formatting, Markdown preview, narration, export, auth, migration, and multi-novel tests remain green.

## Non-goals
- No LLM, plot analysis, automatic rewrites, global dictionary, replacement of the existing editor, or new frontend framework in this implementation.
