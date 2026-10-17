# Novella

Novella is a local-first novel writing workspace. It stores each signed-in user's manuscripts, character notes, and locations in SQLite and exports each ordered manuscript as Markdown.

## Run it

Requires Node.js 24 or newer.

```sh
npm install
npm start
```

Open [http://localhost:4173](http://localhost:4173). Use the novel selector above the manuscript title to create, switch, or delete novels. Changes are saved automatically in `data/novella.sqlite`.

Each new user begins with two fictional sample novels from the immutable `samples/` templates. Editing them changes only that user's database records; `data/` is reserved for persistent runtime data.

Existing JSON installations must be imported explicitly with `npm run migrate:json`; see the [deployment guide](docs/deployment.md). The importer requires the owner's stable Entra tenant and object IDs and leaves the JSON files untouched.

Scene text supports Markdown. Use the formatting toolbar or `Ctrl/Cmd+B`, `Ctrl/Cmd+I`, and `Ctrl/Cmd+K`, then switch to **Preview** to see the formatted result.

Browser spellcheck is always enabled in the scene editor. In the private Compose deployment, **Proofread scene** and **Proofread chapter** add user-triggered, self-hosted spelling and grammar review. Suggestions appear beside the existing Markdown textarea and never change the manuscript until **Accept** is selected. Previous/next controls move safely among findings, including across chapter scenes.

Spelling findings can be added either to the current novel's dictionary or to the signed-in author's dictionary shared across their novels. Open **Dictionaries** to add words directly or remove them. Matching is exact, Unicode-normalized, and case-insensitive; dictionary entries suppress only matching spelling findings, never grammar or style findings. **Ignore** and **Ignore in scene** remain temporary for the current review.

When ElevenLabs is configured, the **Listen** button reads the current scene aloud. The API key remains on the server and is never sent to the browser.

Exports use level-one headings for the book title and level-two headings for chapters. Scene names stay private to the workspace; written scenes are separated with `* * *`, and headings inside scene text are shifted down two levels to preserve the manuscript hierarchy.

## Project portability

Open **Project Settings** from the gear button at the bottom of the manuscript sidebar. The accessible settings dialog shows the current title and author and provides three distinct actions:

- **Export Manuscript (.md)** creates the existing publication-oriented Markdown manuscript.
- **Export Project (.json)** saves a lossless, versioned Novella Project containing the current novel, its planning metadata, and its novel-specific dictionary.
- **Import Project (.json)** validates and previews a project before importing it as a new novel.

Both exports wait for pending autosaves. Import never overwrites an existing novel and does not modify the selected source file. Author-wide dictionary entries are not part of a novel project export. See the [Novella Project format](docs/PROJECT-FORMAT.md) for the exact schema, limits, compatibility rules, and endpoints.

## Development

```sh
npm run dev
npm test
```

## Private deployment

The included [Compose stack](compose.yaml) connects Novella to Neoscion's separately managed shared Caddy network with Microsoft Entra ID authentication. It publishes no host ports and runs LanguageTool on an isolated internal network. Follow the complete [deployment guide](docs/deployment.md) before exposing the application to the internet.
