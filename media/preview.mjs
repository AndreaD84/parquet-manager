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
/** @type {Record<string, unknown>[]} */
let browseRows = [];

let duckdbReady = false;
let duckdbReadyMessage = 'DuckDB ready.';
/** @type {{ rowIndex: number; tr: HTMLTableRowElement } | null} */
let editingRow = null;

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
const layoutEl = document.getElementById('layout');
const schemaPanel = document.getElementById('schemaPanel');
const sqlPanel = document.getElementById('sqlPanel');
const toggleSchemaBtn = /** @type {HTMLButtonElement} */ (document.getElementById('toggleSchemaBtn'));
const toggleSqlBtn = /** @type {HTMLButtonElement} */ (document.getElementById('toggleSqlBtn'));
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

function setSchemaCollapsed(collapsed) {
  schemaPanel.classList.toggle('collapsed', collapsed);
  layoutEl.classList.toggle('schema-collapsed', collapsed);
  toggleSchemaBtn.setAttribute('aria-expanded', String(!collapsed));
  toggleSchemaBtn.title = collapsed ? 'Expand schema' : 'Collapse schema';
  toggleSchemaBtn.querySelector('.toggle-icon').textContent = collapsed ? '▸' : '▾';
}

function setSqlCollapsed(collapsed) {
  sqlPanel.classList.toggle('collapsed', collapsed);
  toggleSqlBtn.setAttribute('aria-expanded', String(!collapsed));
  toggleSqlBtn.title = collapsed ? 'Expand SQL panel' : 'Collapse SQL panel';
  toggleSqlBtn.querySelector('.toggle-icon').textContent = collapsed ? '▸' : '▾';
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

/** @param {unknown} value */
function isEditableValue(value) {
  if (value === null || value === undefined) {
    return true;
  }
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'bigint' || t === 'boolean';
}

/** @param {Record<string, unknown>[]} rows @param {{ name: string; type: string }[]} cols */
function renderTable(rows, cols) {
  tableHead.innerHTML = '';
  tableBody.innerHTML = '';
  editingRow = null;

  const showActions = viewMode === 'browse';

  const headerRow = document.createElement('tr');
  if (showActions) {
    const th = document.createElement('th');
    th.className = 'row-actions-col';
    th.textContent = '';
    headerRow.appendChild(th);
  }
  for (const col of cols) {
    const th = document.createElement('th');
    th.textContent = col.name;
    th.title = col.type;
    headerRow.appendChild(th);
  }
  tableHead.appendChild(headerRow);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tr = document.createElement('tr');
    if (showActions) {
      tr.dataset.rowIndex = String(rowStart + i);
      const actionTd = document.createElement('td');
      actionTd.className = 'row-actions-col';
      renderRowActionsIdle(actionTd, tr, row, cols);
      tr.appendChild(actionTd);
    }
    for (const col of cols) {
      const td = document.createElement('td');
      const text = formatCell(row[col.name]);
      td.textContent = text;
      td.title = text;
      td.dataset.colName = col.name;
      tr.appendChild(td);
    }
    tableBody.appendChild(tr);
  }
}

/**
 * @param {HTMLTableCellElement} actionTd
 * @param {HTMLTableRowElement} tr
 * @param {Record<string, unknown>} row
 * @param {{ name: string; type: string }[]} cols
 */
function renderRowActionsIdle(actionTd, tr, row, cols) {
  actionTd.innerHTML = '';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'row-action-btn edit';
  editBtn.innerHTML = '<span aria-hidden="true">&#9998;</span>';
  editBtn.title = 'Edit row';
  editBtn.disabled = !duckdbReady || editingRow !== null;
  editBtn.addEventListener('click', () => startEdit(tr, row, cols));
  actionTd.appendChild(editBtn);
}

/**
 * @param {HTMLTableRowElement} tr
 * @param {Record<string, unknown>} originalRow
 * @param {{ name: string; type: string }[]} cols
 */
function startEdit(tr, originalRow, cols) {
  if (!duckdbReady || editingRow !== null) {
    return;
  }
  const rowIndex = Number.parseInt(tr.dataset.rowIndex ?? '', 10);
  if (!Number.isFinite(rowIndex)) {
    return;
  }
  tr.classList.add('editing');
  editingRow = { rowIndex, tr };

  const actionTd = /** @type {HTMLTableCellElement} */ (tr.querySelector('td.row-actions-col'));
  actionTd.innerHTML = '';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'row-action-btn save';
  saveBtn.innerHTML = '<span aria-hidden="true">&#10003;</span>';
  saveBtn.title = 'Save row';
  actionTd.appendChild(saveBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'row-action-btn cancel';
  cancelBtn.innerHTML = '<span aria-hidden="true">&#10005;</span>';
  cancelBtn.title = 'Cancel';
  actionTd.appendChild(cancelBtn);

  const tds = tr.querySelectorAll('td[data-col-name]');
  /** @type {{ colName: string; input: HTMLInputElement; original: unknown; editable: boolean }[]} */
  const fields = [];
  let firstInput = null;

  tds.forEach((cell) => {
    const td = /** @type {HTMLTableCellElement} */ (cell);
    const colName = td.dataset.colName ?? '';
    const original = originalRow[colName];
    const editable = isEditableValue(original);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-edit';
    input.value = original === null || original === undefined ? '' : formatCell(original);
    input.dataset.originalIsNull = original === null || original === undefined ? '1' : '0';
    if (!editable) {
      input.readOnly = true;
      input.title = 'Complex value — not editable';
    }
    td.textContent = '';
    td.appendChild(input);
    if (!firstInput && editable) {
      firstInput = input;
    }
    fields.push({ colName, input, original, editable });
  });

  if (firstInput) {
    firstInput.focus();
    firstInput.select();
  }

  cancelBtn.addEventListener('click', () => {
    cancelEdit(tr, originalRow, cols);
  });

  saveBtn.addEventListener('click', () => {
    /** @type {Record<string, unknown>} */
    const changes = {};
    let hasChange = false;
    for (const field of fields) {
      if (!field.editable) {
        continue;
      }
      const originalStr =
        field.original === null || field.original === undefined ? '' : formatCell(field.original);
      const newStr = field.input.value;
      const wasNull = field.input.dataset.originalIsNull === '1';
      if (newStr === originalStr && !(newStr === '' && !wasNull)) {
        continue;
      }
      const newValue = newStr === '' ? null : newStr;
      if (wasNull && newValue === null) {
        continue;
      }
      changes[field.colName] = newValue;
      hasChange = true;
    }
    if (!hasChange) {
      cancelEdit(tr, originalRow, cols);
      return;
    }
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    for (const f of fields) {
      f.input.disabled = true;
    }
    setStatus('Saving row…');
    vscode.postMessage({
      type: 'saveRow',
      rowIndex: editingRow.rowIndex,
      values: changes,
      rowStart,
      pageSize,
    });
  });
}

/**
 * @param {HTMLTableRowElement} tr
 * @param {Record<string, unknown>} originalRow
 * @param {{ name: string; type: string }[]} cols
 */
function cancelEdit(tr, originalRow, cols) {
  tr.classList.remove('editing');
  editingRow = null;
  const tds = tr.querySelectorAll('td[data-col-name]');
  tds.forEach((cell) => {
    const td = /** @type {HTMLTableCellElement} */ (cell);
    const colName = td.dataset.colName ?? '';
    const text = formatCell(originalRow[colName]);
    td.textContent = text;
    td.title = text;
  });
  const actionTd = /** @type {HTMLTableCellElement} */ (tr.querySelector('td.row-actions-col'));
  if (actionTd) {
    renderRowActionsIdle(actionTd, tr, originalRow, cols);
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

toggleSchemaBtn.addEventListener('click', () => {
  setSchemaCollapsed(!schemaPanel.classList.contains('collapsed'));
});

toggleSqlBtn.addEventListener('click', () => {
  setSqlCollapsed(!sqlPanel.classList.contains('collapsed'));
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

  if (msg.type === 'rowSaved') {
    setStatus('Row saved.');
    return;
  }

  if (msg.type === 'rowSaveError') {
    setStatus(msg.message, true);
    if (editingRow) {
      const tr = editingRow.tr;
      tr.querySelectorAll('button.row-action-btn').forEach((b) => {
        /** @type {HTMLButtonElement} */ (b).disabled = false;
      });
      tr.querySelectorAll('input.cell-edit').forEach((i) => {
        /** @type {HTMLInputElement} */ (i).disabled = false;
      });
    }
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
  browseRows = msg.rows;
  const rowEnd = msg.rowEnd;

  fileNameEl.textContent = msg.fileName;
  statsEl.textContent = `${totalRows.toLocaleString()} rows · ${columns.length} columns`;
  renderSchema(columns);
  renderTable(browseRows, columns);
  updatePager(rowEnd);
  setStatus(`Showing rows ${rowStart + 1}–${rowEnd} of ${totalRows.toLocaleString()}`);
});

vscode.postMessage({ type: 'ready' });
