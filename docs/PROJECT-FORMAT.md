# Novella Project format

The Novella Project format is a UTF-8 JSON portability format for one novel. It is separate from the publication-oriented Markdown export and from infrastructure backups.

## Version 1 envelope

Every v1 file has exactly these top-level fields:

```json
{
  "format": "novella-project",
  "version": 1,
  "exportedAt": "2026-10-16T12:00:00.000Z",
  "novel": {
    "id": "novel-example",
    "createdAt": "2026-10-01T12:00:00.000Z",
    "updatedAt": "2026-10-16T11:30:00.000Z",
    "project": {
      "version": 1,
      "title": "Example Novel",
      "author": "Example Author",
      "chapters": [],
      "characters": [],
      "locations": []
    }
  },
  "dictionaries": {
    "novel": [
      {
        "entry": "Caelion",
        "createdAt": "2026-10-15T09:00:00.000Z"
      }
    ]
  }
}
```

The complete sample fixture is [`test/fixtures/novella-project-v1.json`](../test/fixtures/novella-project-v1.json).

The `novel.project` document contains these exact nested shapes:

- Chapter: `id`, `title`, `summary`, and ordered `scenes`.
- Scene: `id`, `title`, `synopsis`, and Markdown `content`.
- Character and location: `id`, `name`, `role`, and `description`.

Array order is authoritative. IDs are stable inside an exported file. Import generates a new top-level novel ID to prevent overwrites while retaining valid internal chapter, scene, character, and location IDs.

## Validation limits

- The request body is limited to 20 MiB.
- IDs contain 1–100 ASCII letters, numbers, or hyphens and must be unique across the project document.
- Title and author: 200 characters each.
- Chapter title: 300; summary: 5,000.
- Scene title: 300; synopsis: 5,000; content: 1,000,000.
- Reference name: 300; role: 500; description: 50,000.
- At most 1,000 chapters, 10,000 total scenes, 5,000 characters, 5,000 locations, and 500 novel dictionary entries.
- Timestamps must parse as ISO-8601 values.
- Dictionary entries use the same normalized single-word rules as Novella's novel dictionary and must be unique case-insensitively.

All documented fields are required, including empty arrays and empty optional text. Unknown fields, missing fields, duplicate IDs, malformed nested data, invalid dictionary entries, and unsupported format or document versions are rejected before any write.

## Ownership and import behavior

Project exports include only the requested novel and that novel's dictionary. They never include database user IDs, Entra identity fields, sessions, credentials, configuration, tokens, or the author-wide dictionary.

Import is always **as a new novel**. The destination identity becomes the owner, the source top-level novel ID is never reused, and existing novels are never updated. The browser first submits the unchanged file for validation and summary preview. Only after explicit confirmation does it submit the same content for import. The novel and all novel-dictionary entries are inserted in one SQLite transaction and roll back together on failure.

The original file is not modified. Imported `createdAt` and `updatedAt` metadata and novel-dictionary creation timestamps are preserved.

## HTTP endpoints

- `GET /api/novels/:id/project-export` downloads an owned project as `<safe-title>.novella.json`.
- `POST /api/projects/import/preview` strictly validates a JSON envelope and returns a non-writing content summary.
- `POST /api/projects/import` validates again and atomically creates a new owned novel.

Both import endpoints require `Content-Type: application/json`, authentication when enabled, and the existing same-origin protection. Cross-user exports return `404` without disclosing whether a novel exists.

## Compatibility

The portable-format version is independent of the SQLite schema version and the nested novel document version. Novella v1 rejects later versions with an actionable error rather than discarding fields. A later format revision must add an explicit parser and documented upgrade path; it must not reinterpret v1 files silently.

Author-wide dictionary portability is intentionally deferred to a separately scoped, explicitly user-owned author-library format.
