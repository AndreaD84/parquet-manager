// @ts-check
const vscode = acquireVsCodeApi();

const PARQUET_VIEW = 'parquet_data';
const DEFAULT_SQL = `SELECT * FROM ${PARQUET_VIEW} LIMIT 100`;

/** @type {{ name: string; type: string }[]} */
let columns = [];
let totalRows = 0;
let rowStart = 0;
let pageSize = 100;
/** @type {'browse' | 'sql'} */
let viewMode = 'browse';
/** @type {Record<string, unknown>[]} */
let sqlResultRows = [];
/** @type {{ name: string; type: string }[]} */
let sqlResultColumns = [];

let duckdbReady = false;
let duckdbReadyMessage = 'DuckDB ready.';

const fileNameEl = document.getElementById('fileName');
const statsEl = document.getElementById('stats');
const rowStartEl = /** @type {HTMLInputElement} */ (document.getElementById('rowStart'));
const rowEndEl = document.getElementById('rowEnd');
const totalRowsEl = document.getElementById('totalRows');
const prevBtn = /** @type {HTMLButtonElement} */ (document.getElementById('prevBtn'));
const nextBtn = /** @type {HTMLButtonElement} */ (document.getElementById('nextBtn'));
const pageSizeEl = /** @type {HTMLSelectElement} */ (document.getElementById('pageSize'));
const schemaList = document.getElementById('schemaList');
const statusEl = document.getElementById('status');
const duckdbStatusEl = document.getElementById('duckdbStatus');
const tableHead = document.getElementById('tableHead');
const tableBody = document.getElementById('tableBody');
const sqlInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('sqlInput'));
const runSqlBtn = /** @type {HTMLButtonElement} */ (document.getElementById('runSqlBtn'));
const resetSqlBtn = /** @type {HTMLButtonElement} */ (document.getElementById('resetSqlBtn'));
const pagerEl = document.getElementById('pager');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function setDuckdbStatus(text, isError = false) {
  if (!duckdbStatusEl) {
    return;
  }
  duckdbStatusEl.textContent = text;
  duckdbStatusEl.classList.toggle('error', isError);
}

function updateRunButton() {
  runSqlBtn.disabled = !duckdbReady;
}

function formatCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSchema(cols) {
  schemaList.innerHTML = '';
  for (const col of cols) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="col-name">${escapeHtml(col.name)}</div><div class="col-type">${escapeHtml(col.type)}</div>`;
    schemaList.appendChild(li);
  }
}

/** @param {Record<string, unknown>[]} rows @param {{ name: string; type: string }[]} cols */
function renderTable(rows, cols) {
  tableHead.innerHTML = '';
  tableBody.innerHTML = '';

  const headerRow = document.createElement('tr');
  for (const col of cols) {
    const th = document.createElement('th');
    th.textContent = col.name;
    th.title = col.type;
    headerRow.appendChild(th);
  }
  tableHead.appendChild(headerRow);

  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const col of cols) {
      const td = document.createElement('td');
      const text = formatCell(row[col.name]);
      td.textContent = text;
      td.title = text;
      tr.appendChild(td);
    }
    tableBody.appendChild(tr);
  }
}

function updatePager(rowEnd) {
  rowStartEl.value = String(rowStart);
  rowEndEl.textContent = String(rowEnd);
  totalRowsEl.textContent = String(totalRows);
  prevBtn.disabled = rowStart <= 0;
  nextBtn.disabled = rowEnd >= totalRows;
}

function setViewMode(mode) {
  viewMode = mode;
  pagerEl.classList.toggle('hidden', mode === 'sql');
  resetSqlBtn.disabled = mode === 'browse';
}

function requestPage() {
  if (viewMode === 'sql') {
    renderSqlPage();
    return;
  }
  setStatus('Loading rows…');
  vscode.postMessage({ type: 'loadPage', rowStart, pageSize });
}

function renderSqlPage() {
  const rowEnd = Math.min(rowStart + pageSize, totalRows);
  const pageRows = sqlResultRows.slice(rowStart, rowEnd);
  renderTable(pageRows, sqlResultColumns);
  updatePager(rowEnd);
  setStatus(
    `SQL result: rows ${rowStart + 1}–${rowEnd} of ${totalRows.toLocaleString()} (${sqlResultColumns.length} columns)`,
  );
}

function runSql() {
  if (!duckdbReady) {
    setStatus('DuckDB is still starting…', true);
    return;
  }
  const sql = sqlInput.value.trim();
  if (!sql) {
    setStatus('Enter a SQL query.', true);
    return;
  }
  runSqlBtn.disabled = true;
  setStatus('Running SQL…');
  vscode.postMessage({ type: 'runSql', sql });
}

function resetSql() {
  sqlInput.value = DEFAULT_SQL;
  sqlResultRows = [];
  sqlResultColumns = [];
  setViewMode('browse');
  rowStart = 0;
  requestPage();
}

prevBtn.addEventListener('click', () => {
  rowStart = Math.max(0, rowStart - pageSize);
  requestPage();
});

nextBtn.addEventListener('click', () => {
  rowStart = Math.min(Math.max(0, totalRows - 1), rowStart + pageSize);
  requestPage();
});

rowStartEl.addEventListener('change', () => {
  const parsed = Number.parseInt(rowStartEl.value, 10);
  rowStart = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  requestPage();
});

pageSizeEl.addEventListener('change', () => {
  pageSize = Number.parseInt(pageSizeEl.value, 10) || 100;
  requestPage();
});

runSqlBtn.addEventListener('click', runSql);
resetSqlBtn.addEventListener('click', resetSql);

sqlInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    runSql();
  }
});

sqlInput.value = DEFAULT_SQL;
updateRunButton();
resetSqlBtn.disabled = true;

window.addEventListener('message', (event) => {
  const msg = event.data;

  if (msg.type === 'error') {
    setStatus(msg.message, true);
    return;
  }

  if (msg.type === 'sqlStatus') {
    if (msg.state === 'ready') {
      duckdbReady = true;
      duckdbReadyMessage = msg.message ?? 'DuckDB ready.';
      updateRunButton();
      setDuckdbStatus(duckdbReadyMessage);
    } else if (msg.state === 'error') {
      duckdbReady = false;
      updateRunButton();
      setDuckdbStatus(msg.message ?? 'DuckDB failed.', true);
    } else if (msg.state !== 'running') {
      duckdbReady = false;
      updateRunButton();
      setDuckdbStatus(msg.message ?? 'Loading DuckDB…');
    }
    return;
  }

  if (msg.type === 'sqlError') {
    updateRunButton();
    setDuckdbStatus(duckdbReadyMessage);
    setStatus(msg.message, true);
    return;
  }

  if (msg.type === 'sqlResult') {
    updateRunButton();
    setDuckdbStatus(duckdbReadyMessage);
    sqlResultRows = msg.rows;
    sqlResultColumns = msg.columns;
    columns = msg.columns;
    totalRows = msg.rowCount;
    rowStart = 0;
    setViewMode('sql');
    renderSchema(msg.columns);
    renderSqlPage();
    return;
  }

  if (msg.type !== 'fileInfo' || viewMode === 'sql') {
    return;
  }

  columns = msg.columns;
  totalRows = msg.totalRows;
  rowStart = msg.rowStart;
  const rowEnd = msg.rowEnd;

  fileNameEl.textContent = msg.fileName;
  statsEl.textContent = `${totalRows.toLocaleString()} rows · ${columns.length} columns`;
  renderSchema(columns);
  renderTable(msg.rows, columns);
  updatePager(rowEnd);
  setStatus(`Showing rows ${rowStart + 1}–${rowEnd} of ${totalRows.toLocaleString()}`);
});

vscode.postMessage({ type: 'ready' });
