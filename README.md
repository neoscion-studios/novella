# Novella

Novella is a local-first novel writing workspace. It stores each signed-in user's manuscripts, character notes, and locations in SQLite and exports each ordered manuscript as Markdown.

## Run it

Requires Node.js 24 or newer.

```sh
npm install
npm start
```

Open [http://localhost:4173](http://localhost:4173). Use the novel selector above the manuscript title to create, switch, or delete novels. Changes are saved automatically in `data/novella.sqlite`.

Each new user begins with two fictional sample novels from `data/samples/`. Editing them changes only that user's database records.

Existing JSON installations must be imported explicitly with `npm run migrate:json`; see the [deployment guide](docs/deployment.md). The importer requires the owner's stable Entra tenant and object IDs and leaves the JSON files untouched.

Scene text supports Markdown. Use the formatting toolbar or `Ctrl/Cmd+B`, `Ctrl/Cmd+I`, and `Ctrl/Cmd+K`, then switch to **Preview** to see the formatted result.

When ElevenLabs is configured, the **Listen** button reads the current scene aloud. The API key remains on the server and is never sent to the browser.

Exports use level-one headings for the book title and level-two headings for chapters. Scene names stay private to the workspace; written scenes are separated with `* * *`, and headings inside scene text are shifted down two levels to preserve the manuscript hierarchy.

## Development

```sh
npm run dev
npm test
```

## Private deployment

The included [Compose stack](compose.yml) runs Novella behind Traefik and Let's Encrypt with Microsoft Entra ID authentication. Follow the complete [deployment guide](docs/deployment.md) before exposing the host to the internet.
