# Parquet Manager

VS Code / Cursor extension to preview and manage Apache Parquet files.

## Features

- **Parquet Preview** custom editor — open `.parquet` files in a table view with schema sidebar
- **Pagination** — browse large files without loading everything into memory
- **Schema** — column names and types; command to open schema as text
- **Export** — CSV or JSON via Explorer context menu or commands

Compression codecs (GZip, ZSTD, Brotli, LZ4, etc.) are supported via [hyparquet-compressors](https://github.com/hyparam/hyparquet-compressors).

## Development

```bash
npm install
npm run compile
```

Press **F5** in VS Code or Cursor to launch an Extension Development Host, then open a `.parquet` file.

## Usage

1. Open any `.parquet` file — the Parquet Preview editor opens by default.
2. Use **Parquet: Show Schema**, **Export to CSV**, or **Export to JSON** from the Command Palette or Explorer right-click menu.

## Tech

- [hyparquet](https://github.com/hyparam/hyparquet) for reading Parquet
- VS Code Custom Editor API (works in Cursor with the same extension model)
