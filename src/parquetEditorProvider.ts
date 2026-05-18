import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { assertSelectOnly, DuckdbService } from './duckdbService';
import { ParquetService, serializeRows } from './parquetService';

interface WebviewReadyMessage {
  type: 'ready';
}

interface WebviewLoadPageMessage {
  type: 'loadPage';
  rowStart: number;
  pageSize: number;
}

interface WebviewRunSqlMessage {
  type: 'runSql';
  sql: string;
}

interface WebviewSaveRowMessage {
  type: 'saveRow';
  rowIndex: number;
  values: Record<string, unknown>;
  rowStart: number;
  pageSize: number;
}

type WebviewInboundMessage =
  | WebviewReadyMessage
  | WebviewLoadPageMessage
  | WebviewRunSqlMessage
  | WebviewSaveRowMessage;

export class ParquetEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'parquet-manager.preview';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly parquetService: ParquetService,
    private readonly duckdbService: DuckdbService,
  ) {}

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const uri = document.uri;

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
    webviewPanel.title = path.basename(uri.fsPath);

    const post = (message: unknown) => {
      webviewPanel.webview.postMessage(message);
    };

    const postError = (message: string) => {
      post({ type: 'error', message });
    };

    void this.startDuckDb(uri.fsPath, post);

    webviewPanel.webview.onDidReceiveMessage(async (raw: WebviewInboundMessage) => {
      try {
        if (raw.type === 'ready') {
          await this.sendBrowsePage(uri, webviewPanel.webview, 0, 100);
          return;
        }

        if (raw.type === 'loadPage') {
          await this.sendBrowsePage(uri, webviewPanel.webview, raw.rowStart, raw.pageSize);
          return;
        }

        if (raw.type === 'runSql') {
          assertSelectOnly(raw.sql);
          const result = await this.duckdbService.query(uri.fsPath, raw.sql);
          try {
            post({
              type: 'sqlResult',
              columns: result.columns,
              rows: serializeRows(result.rows),
              rowCount: result.rowCount,
            });
          } catch (postErr) {
            const detail = postErr instanceof Error ? postErr.message : String(postErr);
            post({
              type: 'sqlError',
              message: `Could not send results to the preview (${detail}). Try LIMIT on large result sets.`,
            });
          }
          return;
        }

        if (raw.type === 'saveRow') {
          await this.saveRow(uri, webviewPanel.webview, raw, post);
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (raw.type === 'runSql') {
          post({ type: 'sqlError', message });
        } else if (raw.type === 'saveRow') {
          post({ type: 'rowSaveError', message });
        } else {
          postError(message);
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      void this.duckdbService.dispose();
    });
  }

  private async startDuckDb(
    filePath: string,
    post: (message: unknown) => void,
  ): Promise<void> {
    post({ type: 'sqlStatus', state: 'loading', message: 'Starting DuckDB…' });
    try {
      await this.duckdbService.ensureReady(filePath);
      post({ type: 'sqlStatus', state: 'ready', message: 'DuckDB ready — you can run SQL queries.' });
      await this.sendColumnTypes(filePath, post);
    } catch (err) {
      post({
        type: 'sqlStatus',
        state: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async sendColumnTypes(
    filePath: string,
    post: (message: unknown) => void,
  ): Promise<void> {
    try {
      const map = await this.duckdbService.getColumnTypes(filePath);
      const types: Record<string, string> = {};
      for (const [name, type] of map) {
        types[name] = type;
      }
      post({ type: 'columnTypes', types });
    } catch {
    }
  }

  private async saveRow(
    uri: vscode.Uri,
    webview: vscode.Webview,
    message: WebviewSaveRowMessage,
    post: (message: unknown) => void,
  ): Promise<void> {
    const tmpPath = `${uri.fsPath}.parquet-manager.tmp`;
    try {
      const codec = await this.parquetService.getOriginalCodec(uri);
      await this.duckdbService.writeRowUpdate(
        uri.fsPath,
        tmpPath,
        message.rowIndex,
        message.values,
        codec,
      );
      await this.duckdbService.dispose();
      await swapFile(tmpPath, uri.fsPath);
      await this.duckdbService.ensureReady(uri.fsPath);
      post({ type: 'rowSaved', rowIndex: message.rowIndex });
      await this.sendColumnTypes(uri.fsPath, post);
      await this.sendBrowsePage(uri, webview, message.rowStart, message.pageSize);
    } catch (err) {
      try {
        await fs.unlink(tmpPath);
      } catch {
      }
      throw err;
    }
  }

  private async sendBrowsePage(
    uri: vscode.Uri,
    webview: vscode.Webview,
    rowStart: number,
    pageSize: number,
  ): Promise<void> {
    const info = await this.parquetService.getFileInfo(uri);
    const page = await this.parquetService.readPage(uri, rowStart, pageSize);
    webview.postMessage({
      type: 'fileInfo',
      fileName: path.basename(uri.fsPath),
      filePath: uri.fsPath,
      ...page,
    });
    void vscode.window.setStatusBarMessage(
      `Parquet: ${info.rowCount.toLocaleString()} rows, ${info.columns.length} columns`,
      3000,
    );
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'preview.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'preview.mjs'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Parquet Preview</title>
</head>
<body>
  <header class="toolbar">
    <div class="file-meta">
      <span id="fileName" class="file-name">Loading…</span>
      <span id="stats" class="stats"></span>
    </div>
    <div id="pager" class="pager">
      <button id="prevBtn" title="Previous page">← Prev</button>
      <label>
        Rows
        <input id="rowStart" type="number" min="0" value="0" />
        –
        <span id="rowEnd">0</span>
        of <span id="totalRows">0</span>
      </label>
      <button id="nextBtn" title="Next page">Next →</button>
      <label class="page-size">
        Page size
        <select id="pageSize">
          <option value="50">50</option>
          <option value="100" selected>100</option>
          <option value="250">250</option>
          <option value="500">500</option>
        </select>
      </label>
    </div>
  </header>
  <section id="sqlPanel" class="sql-panel collapsed">
    <div class="sql-toolbar">
      <button id="toggleSqlBtn" class="section-toggle" type="button" aria-expanded="false" aria-controls="sqlContent" title="Expand SQL panel">
        <span class="toggle-icon" aria-hidden="true">▸</span>
        <span>SQL</span>
      </button>
      <div class="sql-actions">
        <button id="runSqlBtn" type="button" title="Run query (Ctrl+Enter)">
          <span aria-hidden="true">▶</span>
          <span>Run</span>
        </button>
        <button id="resetSqlBtn" type="button" title="Clear filter and return to browse mode">
          <span aria-hidden="true">↺</span>
          <span>Reset</span>
        </button>
      </div>
    </div>
    <div id="sqlContent" class="sql-content">
      <textarea id="sqlInput" class="sql-input" rows="3" spellcheck="false" placeholder="SELECT * FROM parquet_data WHERE …"></textarea>
      <p id="duckdbStatus" class="duckdb-status">Starting DuckDB…</p>
      <p class="sql-hint">Ctrl+Enter to run the query</p>
    </div>
  </section>
  <main id="layout" class="layout schema-collapsed">
    <aside id="schemaPanel" class="schema-panel collapsed">
      <button id="toggleSchemaBtn" class="section-toggle schema-toggle" type="button" aria-expanded="false" aria-controls="schemaList" title="Expand schema">
        <span class="toggle-icon" aria-hidden="true">▸</span>
        <span class="schema-title">Schema</span>
      </button>
      <ul id="schemaList"></ul>
    </aside>
    <section class="table-panel">
      <div id="status" class="status">Loading parquet file…</div>
      <div class="table-wrap">
        <table id="dataTable">
          <thead id="tableHead"></thead>
          <tbody id="tableBody"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

async function swapFile(src: string, dst: string): Promise<void> {
  const delays = [50, 100, 200, 400, 600, 800, 1000, 1500];
  let lastErr: unknown;
  for (let i = 0; i <= delays.length; i++) {
    try {
      await fs.rename(src, dst);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'ENOTEMPTY') {
        throw err;
      }
      if (i === delays.length) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[i]));
    }
  }

  try {
    await fs.copyFile(src, dst);
    await fs.unlink(src);
    return;
  } catch (copyErr) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const copyMsg = copyErr instanceof Error ? copyErr.message : String(copyErr);
    throw new Error(
      `Could not replace the parquet file. The file may be open in another program or locked by antivirus. Original error: ${msg}. Fallback copy also failed: ${copyMsg}`,
    );
  }
}
