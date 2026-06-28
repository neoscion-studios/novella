# Novella

Novella is a local-first novel writing workspace. It stores the manuscript, character notes, and locations in a readable JSON file and exports the ordered manuscript as Markdown.

## Run it

Requires Node.js 20 or newer. No package installation is needed.

```sh
npm start
```

Open [http://localhost:4173](http://localhost:4173). Changes are saved automatically to `data/project.json`.

Scene text supports Markdown. Use the formatting toolbar or `Ctrl/Cmd+B`, `Ctrl/Cmd+I`, and `Ctrl/Cmd+K`, then switch to **Preview** to see the formatted result.

Exports use level-one headings for the book title and level-two headings for chapters. Scene names stay private to the workspace; written scenes are separated with `* * *`, and headings inside scene text are shifted down two levels to preserve the manuscript hierarchy.

## Development

```sh
npm run dev
npm test
```
