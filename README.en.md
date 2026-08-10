<p align="center">
  <img src="apps/fnos/package/ICON_256.PNG" width="128" height="128" alt="Flux Reader icon">
</p>

<h1 align="center">Flux Reader</h1>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  A local-first Markdown reader and editor built for fnOS and macOS.
  <br>
  Read, edit, search, and safely recover multiple documents in one focused workspace.
</p>

<p align="center">
  <a href="https://github.com/Derrors/flux-reader/actions/workflows/fnos.yml"><img src="https://github.com/Derrors/flux-reader/actions/workflows/fnos.yml/badge.svg" alt="fnOS CI"></a>
  <a href="https://github.com/Derrors/flux-reader/actions/workflows/macos.yml"><img src="https://github.com/Derrors/flux-reader/actions/workflows/macos.yml/badge.svg" alt="macOS CI"></a>
  <a href="https://github.com/Derrors/flux-reader/releases/latest"><img src="https://img.shields.io/github/v/release/Derrors/flux-reader?display_name=tag&sort=semver" alt="Latest Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

## A Markdown workspace for everyday use

Flux Reader goes beyond rendering Markdown. It lets you organize folders, search documents, edit beside
a live preview, and protect your work across tabs, restarts, and save conflicts.

- **Comfortable reading** — GFM tables, task lists, syntax highlighting, KaTeX, Mermaid, and a table of contents.
- **Focused editing** — Preview, edit, and split views with synchronized editor and preview scrolling.
- **Fast find and replace** — Previous/next match, replace one, or replace all within the current document.
- **Multi-document workflows** — Up to 12 tabs, visible unsaved markers, and automatic session restoration.
- **Knowledge-folder navigation** — Open multiple workspaces, browse their trees, and search names and contents.
- **Recovery you can trust** — Draft recovery, external-change detection, safe saves, and retained recovery versions.
- **A consistent appearance** — Light, dark, and system themes with the same rich renderer on both platforms.

## Platform support

| | fnOS | macOS |
|---|---|---|
| App type | Native fnOS package | Native SwiftUI app |
| Open from | Files, folders, file associations | Files, folders, Finder associations, drag and drop |
| Workspaces | Up to 8 session workspaces | Up to 8 persistent workspaces |
| Document tabs | Up to 12 with session restore | Up to 12 with session and draft restore |
| Editing and saving | Save existing authorized files | Save in place and Save As |
| File updates | Automatic polling | Automatic FSEvents updates |
| Access control | fnOS app authorization + current-user ACL | App Sandbox + security-scoped bookmarks |

Flux Reader supports `.md`, `.markdown`, and `.mdx`. Editable documents must be valid UTF-8 and no larger
than 2 MB.

## Installation

Download the latest build from [GitHub Releases](https://github.com/Derrors/flux-reader/releases/latest).

### fnOS

1. Download `flux-reader-<version>.fpk`.
2. Open the fnOS App Center and choose offline installation.
3. Add readable folders under **System Settings → Apps → Flux Reader → App Settings → Access Permissions**.
4. Launch Flux Reader from the desktop and open a file or folder.

Requirements: **fnOS 1.2.0401 or later** and Feiniu App 1.34.0 or later.

### macOS

1. Download `Flux-Reader-<version>-universal.dmg`. If the release only provides a build containing
   `unnotarized` in its name, that build is suitable for personal use and testing.
2. Open the DMG and drag Flux Reader into Applications.
3. Use the system picker to grant access when opening a file or folder for the first time.

The macOS client requires **macOS 14 or later** and supports both Apple Silicon and Intel Macs.
Gatekeeper may warn about or block an unnotarized build. Prefer a notarized asset whenever one is available.

## Quick start

1. Choose **Open File** for a single document, or **Open Folder** to create a workspace.
2. Use the view switcher to choose preview, edit, or side-by-side split mode.
3. Open the find bar, or use a keyboard shortcut to search and replace within the active document.
4. Open more documents as needed. Tabs show unsaved changes and are restored on the next launch.

| Action | fnOS | macOS |
|---|---|---|
| Find | `⌘/Ctrl + F` | `⌘ + F` |
| Find and replace | `⌘/Ctrl + H` | `⌘ + Option + F` |
| Save | `⌘/Ctrl + S` | `⌘ + S` |

## Data and security

Flux Reader reads directly from the Mac files or fnOS folders you select. It does not require uploading
documents to a third-party service. fnOS checks both the app's authorized scope and the signed-in user's
permissions; macOS uses App Sandbox and security-scoped bookmarks.

Before saving, Flux Reader verifies the disk version to avoid silently overwriting external changes.
Unsaved drafts and retained recovery versions protect work across unexpected exits or interrupted writes.

See the [technical and development guide](docs/TECHNICAL.md) for the complete security boundaries,
recovery transactions, and performance limits. This guide is currently available in Chinese.

## Documentation

- [Technical architecture, development, testing, and releases](docs/TECHNICAL.md) — Chinese
- [fnOS platform notes](apps/fnos/README.md) — Chinese
- [macOS platform notes](apps/macos/README.md) — Chinese
- [Shared Web reader notes](packages/reader-web/README.md) — Chinese

## Contributing

Issues, usability feedback, and feature ideas are welcome in
[GitHub Issues](https://github.com/Derrors/flux-reader/issues). Before contributing code, read the
[technical and development guide](docs/TECHNICAL.md) and run the relevant tests.

## License

Flux Reader is available under the [MIT License](LICENSE).
