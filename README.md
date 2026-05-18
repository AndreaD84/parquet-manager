# Parquet Manager

VS Code / Cursor extension to preview, query, and edit Apache Parquet files.

## Features

- **Parquet Preview** custom editor — open `.parquet` files in a paginated table view, with a collapsible schema sidebar and SQL panel
- **Pagination** — browse large files without loading everything into memory (50 / 100 / 250 / 500 rows per page)
- **SQL filter (DuckDB)** — run `SELECT` / `WITH … SELECT` queries against the open file through the `parquet_data` view; results render in the same table; Ctrl+Enter to execute
- **Column visibility** — toggle individual columns on/off from the Schema panel checkboxes (browse mode)
- **Inline row editing** — edit any row in place with type-aware controls (text / number / boolean dropdown / date / datetime / time pickers) and save back into the parquet file
- **Safe writes** — every save goes through a temp file, atomic swap, retry-on-`EPERM`, and pre-flight `CAST` validation per column so a bad value never corrupts the original file
- **Codec preservation** — the saved file keeps the original compression codec (`SNAPPY`, `GZIP`, `ZSTD`, `BROTLI`, `LZ4`, `LZ4_RAW`, or uncompressed)
- **Schema** — column names and types in the sidebar plus a `Parquet: Show Schema` command to dump the schema as text
- **Export** — CSV or JSON via the Explorer context menu, Command Palette, or editor title menu
- **Theme-aware UI** — inputs, selects, and native pickers follow the VS Code / Cursor color theme (dark / light / high-contrast)

Compression codecs (GZip, ZSTD, Brotli, LZ4, etc.) on read are supported via [hyparquet-compressors](https://github.com/hyparam/hyparquet-compressors). On write, DuckDB writes the parquet output.

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
4. Use the **Schema** sidebar checkboxes to hide/show columns in browse mode.
5. Click the pencil icon on any row to edit it; save with the check icon or cancel with the X.

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

### Editing rows

- Click the pencil icon (✎) on a row. Each cell becomes the input control that matches its DuckDB column type:
  - `BOOLEAN` → dropdown with `(null) / true / false`
  - Integer types (`TINYINT … HUGEINT` signed and unsigned) → `<input type="number" step="1">`
  - Float / `DECIMAL` types → `<input type="number" step="any">`
  - `DATE` → date picker
  - `TIMESTAMP*` → datetime-local picker
  - `TIME` / `TIME WITH TIME ZONE` → time picker
  - `VARCHAR` / `TEXT` / `UUID` → text input
  - `BLOB` / `LIST` / `STRUCT` / `MAP` / `ARRAY` / `UNION` → read-only (not editable)
- Empty input means `NULL` (and the boolean `(null)` option works the same).
- Click ✓ to save; the value is `CAST` to the original column type. If the cast fails (e.g., `"abc"` → `BIGINT`) you'll see an error and the file is **not modified**.
- Click ✗ to cancel and restore the original cell text.

### How writes stay safe

1. The new row is computed with a DuckDB `COPY` that reads the original file, replaces only the changed cells using the row index, and casts each new value to the original column type.
2. The result is written to a temp file (`<name>.parquet.parquet-manager.tmp`) using the same compression codec as the original.
3. DuckDB releases the original, then the temp is renamed over the original. On Windows EPERM/EBUSY (antivirus, OneDrive, another viewer), the rename is retried with exponential backoff and falls back to `copyFile` + `unlink`.
4. If any step fails, the temp file is deleted and the original parquet is left untouched.

## Tech

- [hyparquet](https://github.com/hyparam/hyparquet) for parquet reading and metadata
- [hyparquet-compressors](https://github.com/hyparam/hyparquet-compressors) for compression codecs on read
- [@duckdb/duckdb-wasm](https://github.com/duckdb/duckdb-wasm) (Node blocking build) running in the extension host for SQL queries and writes
- VS Code Custom Editor API (works in Cursor with the same extension model)
