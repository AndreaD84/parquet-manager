# Parquet Manager

VS Code / Cursor extension to preview and manage Apache Parquet files.

## Features

- **Parquet Preview** custom editor — open `.parquet` files in a table view with schema sidebar
- **Pagination** — browse large files without loading everything into memory
- **SQL filter** — run DuckDB queries on the open file (`parquet_data` view); Ctrl+Enter to execute
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
3. In the SQL panel, query the `parquet_data` view (columns match your file). Press **Ctrl+Enter** or **Run** to execute. Only `SELECT` / `WITH … SELECT` queries are allowed.

### DuckDB query examples

Filter rows with `WHERE` (replace column names with yours):

```sql
-- Equality and simple filters
SELECT * FROM parquet_data
WHERE status = 'active'
LIMIT 100;

SELECT * FROM parquet_data
WHERE country IN ('US', 'CA', 'GB')
  AND created_at >= '2024-01-01';

-- Numeric range
SELECT id, amount, category FROM parquet_data
WHERE amount BETWEEN 10 AND 500
  AND category IS NOT NULL;

-- Text search
SELECT * FROM parquet_data
WHERE name ILIKE '%smith%'
   OR email LIKE '%@example.com';

-- Combine conditions
SELECT * FROM parquet_data
WHERE (region = 'EU' OR region = 'UK')
  AND revenue > 1000
  AND is_deleted = false
ORDER BY revenue DESC
LIMIT 50;

-- Aggregate with a filter
SELECT category, COUNT(*) AS n, AVG(amount) AS avg_amount
FROM parquet_data
WHERE event_date >= '2025-01-01'
GROUP BY category
HAVING COUNT(*) > 10
ORDER BY n DESC;
```

## Tech

- [hyparquet](https://github.com/hyparam/hyparquet) for reading Parquet
- VS Code Custom Editor API (works in Cursor with the same extension model)
