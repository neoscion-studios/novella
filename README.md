# Novella

Novella is a local-first novel writing workspace. It stores manuscripts, character notes, and locations in readable JSON files and exports each ordered manuscript as Markdown.

## Run it

Requires Node.js 20 or newer. No package installation is needed.

```sh
npm start
```

Open [http://localhost:4173](http://localhost:4173). Use the novel selector above the manuscript title to create, switch, or delete novels. Changes are saved automatically under `data/novels/`, with metadata in `data/catalog.json`.

Fresh installations begin with two fictional sample novels from `data/samples/`. The samples are copied into ignored runtime files on first launch, so editing them does not modify the Git repository.

On first launch after upgrading, Novella safely imports the existing `data/project.json` as the first novel and leaves the original file untouched.

Scene text supports Markdown. Use the formatting toolbar or `Ctrl/Cmd+B`, `Ctrl/Cmd+I`, and `Ctrl/Cmd+K`, then switch to **Preview** to see the formatted result.

When ElevenLabs is configured, the **Listen** button reads the current scene aloud. The API key remains on the server and is never sent to the browser.

Exports use level-one headings for the book title and level-two headings for chapters. Scene names stay private to the workspace; written scenes are separated with `* * *`, and headings inside scene text are shifted down two levels to preserve the manuscript hierarchy.

## Development

```sh
npm run dev
npm test
```

## Private deployment

The included [Compose stack](compose.yml) runs Novella behind Traefik, Let's Encrypt, and authentik forward authentication. Follow the complete [deployment guide](docs/deployment.md) before exposing the host to the internet.
