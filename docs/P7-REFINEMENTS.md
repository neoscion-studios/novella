Review the current Novella repository and implement the following Phase 7 refinements.

Read `AGENTS.md`, `docs/SPEC.md`, and the relevant frontend, server, storage, and deployment code before making changes.

### 1. Investigate export/import failures

The Export Project and Import Project controls appear unresponsive in the browser.

Reproduce the reported behavior and identify the underlying cause.

- Verify the frontend event handlers execute.
- Verify export requests reach the server and return valid downloadable files.
- Verify the import file picker opens and the preview workflow operates correctly.
- Inspect browser console and network errors where browser testing is available.
- Ensure errors are clearly communicated to the user.
- Do not display successful export messages until success is verified.

Fix confirmed defects without changing the existing project format or import safety guarantees.

### 2. Introduce Project Settings

Move the export/import controls out of the main writing toolbar.

Add a small gear-shaped Project Settings button near the bottom of the left sidebar.

Clicking the button should open an accessible modal consistent with Novella's existing design.

The modal should contain:

**Project Information**
- Current novel title
- Author

**Export**
- Export Manuscript (.md)
- Export Project (.json)

**Import**
- Import Project (.json)

Preserve the existing import preview and confirmation workflow.

Do not duplicate editing functionality unnecessarily. Project information may initially be read-only if the existing editor already provides title and author editing.

Keep the interface minimalist and responsive.

### 3. Relocate sample projects

Move the immutable sample project files from `data/samples/` to a root-level `samples/` directory.

Update:
- Sample-loading paths in the application
- Dockerfile
- Tests and fixtures where necessary
- README
- AGENTS.md
- Deployment documentation

Ensure the samples are packaged into the Docker image and accessible without requiring write permissions.

The `data/` directory should contain only persistent runtime application data.

Preserve existing sample-seeding behavior and existing user libraries.

### 4. Legacy data cleanup

Inspect references to `data-old`, if any.

Do not automatically delete `data-old` or any existing database files.

Report whether the directory is referenced by application code or deployment configuration.

### 5. Verification

Run the complete automated test suite.

Verify:
- Both export formats download successfully.
- Project import opens the file picker and displays a preview.
- Import creates a new novel without modifying existing novels.
- Project Settings works with keyboard navigation.
- Sample novels load correctly on a fresh installation.
- Existing installations continue working.
- Docker builds successfully.
- `docker compose config --quiet` passes.

Update the specification and documentation to reflect the revised design.

Do not commit, push, or deploy until verification is complete.

Report the root cause of any confirmed export/import failures and summarize all changes.