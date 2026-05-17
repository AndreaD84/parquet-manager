import * as path from 'node:path';
import * as vscode from 'vscode';
import { ParquetService } from './parquetService';

interface WebviewReadyMessage {
  type: 'ready';
}

interface WebviewLoadPageMessage {
  type: 'loadPage';
  rowStart: number;
  pageSize: number;
}

type WebviewInboundMessage = WebviewReadyMessage | WebviewLoadPageMessage;

export class ParquetEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public static readonly viewType = 'parquet-manager.preview';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly parquetService: ParquetService,
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

    const postError = (message: string) => {
      webviewPanel.webview.postMessage({ type: 'error', message });
    };

    webviewPanel.webview.onDidReceiveMessage(async (raw: WebviewInboundMessage) => {
      try {
        if (raw.type === 'ready' || raw.type === 'loadPage') {
          const rowStart = raw.type === 'loadPage' ? raw.rowStart : 0;
          const pageSize = raw.type === 'loadPage' ? raw.pageSize : 100;
          const info = await this.parquetService.getFileInfo(uri);
          const page = await this.parquetService.readPage(uri, rowStart, pageSize);
          webviewPanel.webview.postMessage({
            type: 'fileInfo',
            fileName: path.basename(uri.fsPath),
            filePath: uri.fsPath,
            ...page,
          });
          if (raw.type === 'ready') {
            void vscode.window.setStatusBarMessage(
              `Parquet: ${info.rowCount.toLocaleString()} rows, ${info.columns.length} columns`,
              5000,
            );
          }
        }
      } catch (err) {
        postError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'preview.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'preview.js'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
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
    <div class="pager">
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
  <main class="layout">
    <aside class="schema-panel">
      <h2>Schema</h2>
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
  <script nonce="${nonce}" src="${scriptUri}"></script>
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
