// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {import('./types').ParquetColumn[]} */
  let columns = [];
  let totalRows = 0;
  let rowStart = 0;
  let pageSize = 100;

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
  const tableHead = document.getElementById('tableHead');
  const tableBody = document.getElementById('tableBody');

  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
  }

  function formatCell(value) {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    return String(value);
  }

  function renderSchema() {
    schemaList.innerHTML = '';
    for (const col of columns) {
      const li = document.createElement('li');
      li.innerHTML = `<div class="col-name">${escapeHtml(col.name)}</div><div class="col-type">${escapeHtml(col.type)}</div>`;
      schemaList.appendChild(li);
    }
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** @param {Record<string, unknown>[]} rows */
  function renderTable(rows) {
    tableHead.innerHTML = '';
    tableBody.innerHTML = '';

    const headerRow = document.createElement('tr');
    for (const col of columns) {
      const th = document.createElement('th');
      th.textContent = col.name;
      th.title = col.type;
      headerRow.appendChild(th);
    }
    tableHead.appendChild(headerRow);

    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const col of columns) {
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

  function requestPage() {
    setStatus('Loading rows…');
    vscode.postMessage({ type: 'loadPage', rowStart, pageSize });
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

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'error') {
      setStatus(msg.message, true);
      return;
    }
    if (msg.type !== 'fileInfo') {
      return;
    }

    columns = msg.columns;
    totalRows = msg.totalRows;
    rowStart = msg.rowStart;
    const rowEnd = msg.rowEnd;

    fileNameEl.textContent = msg.fileName;
    statsEl.textContent = `${totalRows.toLocaleString()} rows · ${columns.length} columns`;
    renderSchema();
    renderTable(msg.rows);
    updatePager(rowEnd);
    setStatus(`Showing rows ${rowStart + 1}–${rowEnd} of ${totalRows.toLocaleString()}`);
  });

  vscode.postMessage({ type: 'ready' });
})();
