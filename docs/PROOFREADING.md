# Novella proofreading — implementation specification

Status: Phases 1 and 2 implemented (2026-10-10). This is a bounded proofreading feature, not the future Literary Intelligence system.

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

## Future extension beyond Phase 1
- Personal dictionary (including character names and invented terms), persisted per user or novel: **Phase 2 scope below**.
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

## Phase 1 non-goals
- No LLM, plot analysis, automatic rewrites, global dictionary, replacement of the existing editor, or new frontend framework in Phase 1.

## Phase 2 — Author dictionaries and review improvements (implemented)

### Objective and scope
Make proofreading dependable for fiction without turning Novella into a rich-text editor or an AI rewriting tool. Build on the working Phase 1 implementation rather than replacing it. Read the current source, tests, and `AGENTS.md` before coding; verify which Phase 1 features are already present. Keep this phase bounded to dictionaries, review reliability, chapter workflow, and diagnostics. Do **not** implement Literary Intelligence, background/live checking, or inline decorations.

### A. Dictionaries: novel-specific and author-wide
- Provide **two distinct scopes**: (1) a novel dictionary for names, places, invented words, and terminology belonging to one novel; (2) an author dictionary shared across that author's novels. A word in one novel's dictionary must not silently enter another novel's dictionary.
- Persist entries in the existing SQLite storage layer with explicit user ownership. Design additive, backward-compatible schema changes for existing databases; do not rewrite stored manuscript content or sample templates.
- Treat `(tenantId, objectId)` as the durable user identity. Author dictionary entries belong to that user; novel entries belong to a novel authorized through the existing identity-scoped store. Return 404 for another user's novel, consistent with existing behavior.
- Provide a minimal UI to add a spelling suggestion's original word to either dictionary, view entries by scope, and remove an entry with an accessible confirmation or reversible action. Allow direct entry through the dictionary manager. Do not turn grammar rules or arbitrary multiword passages into dictionary entries by default.
- Normalize whitespace and Unicode consistently; validate entry length, count, and allowed characters, and define case-sensitivity behavior explicitly. Preserve display spelling. Prevent duplicates according to the documented matching policy. Do not use substring matching: accepting `Caelion` must not suppress an unrelated longer word.
- On each review, suppress **only relevant spelling/unknown-word findings** matching entries from the authorized author's dictionary and current novel dictionary. Do not suppress grammar, punctuation, or style findings merely because they contain a dictionary word. Prefer deterministic filtering of normalized provider issues over global changes to the shared LanguageTool instance; never let one user's dictionary affect another.
- Keep dictionary management behind authenticated, same-origin-protected APIs with bounded payloads and no user-controlled upstream provider URLs. Never expose other users' entries. Provide predictable behavior when proofreading is disabled or LanguageTool is unavailable.

### B. Review correctness and usability
- Audit the existing `Accept`, `Ignore`, and `Ignore in scene` behavior before changing it. An accepted replacement must alter **only** the intended source Markdown span and trigger the established autosave path; ignored findings must never mutate the manuscript.
- Bind reviews to the exact novel, scene, and source snapshot. On edits, navigation, or out-of-order responses, reject stale suggestions rather than applying uncertain offsets. Confirm UTF-16 source offsets for Unicode/emoji and Markdown syntax; preserve links, fenced code, emphasis, and surrounding punctuation.
- Improve the issue panel without replacing the native textarea: show category, original excerpt, explanation, replacement choices, and clear previous/next issue navigation. Selecting an issue should focus/select the relevant source range where safe, without losing the author's unsaved edits. Keep keyboard and screen-reader access.
- Verify whether `Proofread chapter` and scene navigation already exist. Implement or repair only what is missing: bounded per-scene checking, grouped results by scene, clear progress/error states, and navigation that never mixes findings from different scenes. Do not silently rewrite a chapter.
- Keep proofreading explicitly user-triggered. Do not add automatic network checks on every keystroke in Phase 2.

### C. Quality diagnostics
- Add deterministic tests for the complete request/projection/response pipeline. Verify that the current full scene snapshot, configured language (default `en-US`), and expected provider settings are sent correctly; check for accidental truncation, filtering, or offset mistakes.
- Use the deliberately error-filled test passage as a **diagnostic fixture**, not a guarantee that LanguageTool will identify every error. Document which findings come from LanguageTool's rules and which are missed; do not invent corrections or misrepresent detection rates.
- Keep provider-neutral issue normalization, private internal checker networking, bounded requests/timeouts, sanitized errors, and graceful checker-unavailable behavior. No new external proofreading service.

### D. Acceptance criteria and verification
1. An author can add an invented word from a spelling finding to the current novel dictionary; subsequent reviews of that novel suppress the matching spelling finding, while grammar findings remain.
2. An author can add a word to their author dictionary and use it across their own novels; another authenticated user cannot read, modify, or benefit from those entries.
3. Dictionary entries survive process/container restarts and existing SQLite databases migrate without loss. Duplicate, invalid, and excessive entries are rejected safely.
4. Removing a word causes its spelling finding to become eligible again on the next review. Dictionary changes do not alter manuscript text.
5. Accepting a correction preserves unrelated Markdown, triggers autosave, and persists after reload. Stale review results cannot edit the wrong text, scene, or novel.
6. Chapter review checks every eligible scene with bounded work, correctly attributes issues, handles an unavailable checker gracefully, and supports safe navigation.
7. Firefox and Safari expose the same Novella proofreading controls after loading the current application assets; native OS Writing Tools remain optional and are not a dependency.
8. Tests cover user/novel isolation, schema upgrades, normalization, Unicode offsets, stale requests, cross-scene navigation, disabled checker, and regressions. Run `npm test`; run `docker compose config --quiet` when available. Verify the Dockerfile copies all runtime modules (including `proofreading/`).
9. Update `README.md`, `docs/SPEC.md`, and relevant deployment documentation for behavior that actually changes. Keep secrets and user data out of commits.

### Suggested Codex delivery order
1. **Audit** current Phase 1 implementation against this specification; list already-complete functionality and gaps before editing.
2. **Storage and tests** for isolated author/novel dictionary entries, including migration from an existing database.
3. **Dictionary APIs and UI** with explicit scope selection and safe spelling-only filtering.
4. **Review hardening** for safe acceptance, stale findings, issue navigation, and chapter review gaps.
5. **Diagnostics, documentation, and deployment verification**; report tests run, remaining limitations, and any deferred features.

### Deferred beyond Phase 2
Optional debounced live proofreading; inline annotations requiring an explicitly evaluated editor approach; configurable languages beyond the initial default; manuscript-aware Literary Intelligence and structured Story Model. None is a prerequisite for completing Phase 2.
