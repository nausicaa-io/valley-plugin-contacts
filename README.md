# Contacts

Address book over vCard files in your vault: ordered groups with colors, cover-aware structured contact cards, typed relations, birthdays in Calendar, and a force-directed relationship graph.

## Contact files

Each person is one `.vcf` file (vCard 4.0, RFC 6350) in the Contacts folder (setting `contactsRoot`, default `Meadow/Orbit`; `/` scans the whole vault). Cards exported by other address books (vCard 2.1, 3.0 and 4.0) are read as they are. Opening a `.vcf` shows the contact. Command-E (Ctrl-E on Windows/Linux) switches between Reading and a full structured Editing view. Footer details offers the same mode switch and configurable name, groups, birthday, email, phone, organization, profession, nickname, address, and website fields. Contact editing stays in the main view; the right sidebar has no Contact editing tab. Edits autosave with guarded writes, and switching to Reading keeps pending saves alive.

- Names, nickname, birthday (`BDAY`, with or without a year), groups (`CATEGORIES`), phone, email, addresses (`ADR` with `LABEL`), organizations (`ORG`/`TITLE`), profession (`ROLE`), websites, social profiles (`SOCIALPROFILE`) and Markdown notes (`NOTE`) use standard properties.
- Relations are `RELATED` entries pointing at the other card's `UID`, so renaming a file never breaks them. Cover image, events and last contact use `X-VALLEY-*` properties.
- An edit rewrites only the properties it changed. Unknown properties, other apps' extensions, embedded photos and further cards in the same file are kept.
- The file name follows the person's name while it still matches it, through the host's guarded rename, which also repairs links to the file.

`tooling/markdownToVcard.ts` converts former Markdown contact notes once: `npx vite-node tooling/markdownToVcard.ts -- <folder>` reports what it would do; add `--write` (and `--remove-markdown`) to convert. It is not part of the packaged plugin.

This repository owns the plugin’s interface, behavior, dependencies, schemas, tests, translations, and compiled releases. It uses Valley manifest API 5 and the injected SDK 6.

Valley ships this core plugin as a verified release artifact in its application resources. Core and external installations run with the same sandbox, permissions, and SDK/IPC contract. The core package and its locale files are never installed into `.valley`; ordinary vault documents and saved plugin data retain their existing locations.

## Search

Contacts explicitly contributes its Markdown `NOTE` content to Tag Search and Content Search through the SDK search-source declaration. Both have independent Contacts switches. Only note hashtags become tags; contact groups and other fields are not inferred as tags. Results open the owning `.vcf` file.

The plugin maintains a rebuildable `note_search` dataset in its own cache through `api.data.dataset`, updating changed notes and removing deleted, renamed, or out-of-scope cards. The vCard files remain the source of truth.

## Platform icons

Platform SVGs live in `.valley/plugins/data/contacts/contact-icon/`, separate from the installed plugin package. On activation, missing defaults are copied from the bundled `contact-icon/` collection; existing files are never replaced. Add or edit named SVGs there, then return to Valley or use **Refresh icons** in Contacts settings. **Open icon folder** opens that directory. No plugin rebuild is needed for custom artwork.

Filenames match platform names regardless of capitalization, spaces, or hyphens. Use `currentColor` for artwork that follows the theme. Existing platform aliases resolve to their matching icons, and unmatched names use `social.svg`. SVGs are restricted to static vector artwork; scripts, embedded HTML, styles, and external resources are removed before rendering.

Click a platform icon in Contacts settings to search the SVG collection and save a manual choice. Choose “Match platform name automatically” to clear the override. The selection applies to settings, the contact editor, and contact cards.

## Package

- `manifest.json`: readable English identity, version, and paired `author` / `authorUrl` arrays.
- `config.json`: runtime entry points, permissions, contributions, and storage declarations.
- `src/`: plugin interface.
- `locales/`: English, German, Spanish, French, and Simplified Chinese catalogs.
- `tests/`: package-owned checks using the portable SDK testkit.
- `runtime/`: compiled installation artifact, including the package’s locale catalogs.
- `vendor/`: pinned SDK, testkit, and build-tool archives for independent development.

The package’s `manifest.name` and `manifest.description` catalog entries translate its identity, including while disabled. Missing translations fall back to this package’s English catalog. A plugin never falls back to Valley’s catalog or another plugin’s catalog.

## Development and releases

Use Node 24.19.0 and npm 11.17.0. From this repository, run:

```sh
npm ci
npm run check
```

The check validates types and package boundaries, runs the package tests, and rebuilds `runtime/`. It requires no Valley source checkout. Keep the rebuilt runtime, locale files, dependency lock, and vendored tools with each release. Increment the package and manifest versions together.

Valley release maintainers explicitly import the compiled artifact into the application’s `plugins.lock.json`; building Valley does not build or read this repository. All privileged work uses declared SDK capabilities, authenticated IPC, and explicit grants. Disabling or unloading the plugin releases its subscriptions and resources.
