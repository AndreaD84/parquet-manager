import * as vscode from 'vscode';
import { DuckdbService } from './duckdbService';
import { ParquetEditorProvider } from './parquetEditorProvider';
import {
  defaultExportUri,
  ParquetService,
  pickParquetUri,
} from './parquetService';

export function activate(context: vscode.ExtensionContext): void {
  const parquetService = new ParquetService();
  const duckdbService = new DuckdbService(context.extensionPath);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      ParquetEditorProvider.viewType,
      new ParquetEditorProvider(context, parquetService, duckdbService),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('parquet-manager.openPreview', async (resource?: vscode.Uri) => {
      const uri = pickParquetUri(resource);
      if (!uri) {
        void vscode.window.showWarningMessage('Open a .parquet file first.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, ParquetEditorProvider.viewType);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('parquet-manager.showSchema', async (resource?: vscode.Uri) => {
      const uri = pickParquetUri(resource);
      if (!uri) {
        void vscode.window.showWarningMessage('Open a .parquet file first.');
        return;
      }
      try {
        const info = await parquetService.getFileInfo(uri);
        const lines = info.columns.map((c) => `${c.name}: ${c.type}`);
        const doc = await vscode.workspace.openTextDocument({
          content: [
            `# Schema: ${uri.fsPath}`,
            '',
            `Rows: ${info.rowCount.toLocaleString()}`,
            `Columns: ${info.columns.length}`,
            '',
            ...lines,
          ].join('\n'),
          language: 'plaintext',
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Failed to read schema: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('parquet-manager.exportCsv', async (resource?: vscode.Uri) => {
      await runExport(resource, '.csv', (uri, target) => parquetService.exportCsv(uri, target), parquetService);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('parquet-manager.exportJson', async (resource?: vscode.Uri) => {
      await runExport(resource, '.json', (uri, target) => parquetService.exportJson(uri, target), parquetService);
    }),
  );
}

async function runExport(
  resource: vscode.Uri | undefined,
  extension: string,
  exportFn: (source: vscode.Uri, target: vscode.Uri) => Promise<void>,
  parquetService: ParquetService,
): Promise<void> {
  const uri = pickParquetUri(resource);
  if (!uri) {
    void vscode.window.showWarningMessage('Select a .parquet file to export.');
    return;
  }

  const defaultUri = defaultExportUri(uri, extension);
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters:
      extension === '.csv'
        ? { CSV: ['csv'] }
        : { JSON: ['json'] },
  });
  if (!target) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Exporting ${extension.slice(1).toUpperCase()}…`,
      cancellable: false,
    },
    async () => {
      try {
        const info = await parquetService.getFileInfo(uri);
        if (info.rowCount > 100_000) {
          const proceed = await vscode.window.showWarningMessage(
            `This file has ${info.rowCount.toLocaleString()} rows. Export may take a while.`,
            'Continue',
            'Cancel',
          );
          if (proceed !== 'Continue') {
            return;
          }
        }
        await exportFn(uri, target);
        const open = await vscode.window.showInformationMessage(
          `Exported to ${target.fsPath}`,
          'Open File',
        );
        if (open === 'Open File') {
          await vscode.window.showTextDocument(target);
        }
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Export failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
}

export function deactivate(): void {}
