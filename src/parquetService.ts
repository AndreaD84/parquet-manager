import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { esmImport } from './esmImport';

export interface ParquetColumn {
  name: string;
  type: string;
}

export interface ParquetFileInfo {
  uri: vscode.Uri;
  filePath: string;
  rowCount: number;
  columns: ParquetColumn[];
}

export interface ParquetPage {
  rows: Record<string, unknown>[];
  rowStart: number;
  rowEnd: number;
  totalRows: number;
  columns: ParquetColumn[];
}

const DEFAULT_PAGE_SIZE = 100;

type HyparquetModule = typeof import('hyparquet');
type CompressorsModule = typeof import('hyparquet-compressors');
type AsyncBuffer = { byteLength: number; slice: (start: number, end?: number) => ArrayBuffer | Promise<ArrayBuffer> };

let hyparquetPromise: Promise<HyparquetModule> | undefined;
let compressorsPromise: Promise<CompressorsModule['compressors']> | undefined;

async function loadHyparquet(): Promise<HyparquetModule> {
  hyparquetPromise ??= esmImport<HyparquetModule>('hyparquet');
  return hyparquetPromise;
}

async function loadCompressors(): Promise<CompressorsModule['compressors']> {
  compressorsPromise ??= esmImport<CompressorsModule>('hyparquet-compressors').then((m) => m.compressors);
  return compressorsPromise;
}

async function loadFileBuffer(filePath: string): Promise<AsyncBuffer> {
  const data = await fs.readFile(filePath);
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return {
    byteLength: buffer.byteLength,
    slice: (start: number, end?: number) => buffer.slice(start, end),
  };
}

function formatSchemaType(element: { type?: unknown; converted_type?: unknown; logical_type?: unknown }): string {
  const parts: string[] = [];
  if (element.type !== undefined) {
    parts.push(String(element.type));
  }
  if (element.converted_type !== undefined) {
    parts.push(String(element.converted_type));
  }
  if (element.logical_type !== undefined) {
    parts.push(String(element.logical_type));
  }
  return parts.join(' / ') || 'unknown';
}

function serializeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('base64');
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeValue(v);
    }
    return out;
  }
  return value;
}

export function serializeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = serializeValue(value);
    }
    return out;
  });
}

export class ParquetService {
  async getFileInfo(uri: vscode.Uri): Promise<ParquetFileInfo> {
    const filePath = uri.fsPath;
    const { parquetMetadataAsync, parquetSchema } = await loadHyparquet();
    const file = await loadFileBuffer(filePath);
    const metadata = await parquetMetadataAsync(file);
    const schema = parquetSchema(metadata);

    const columns: ParquetColumn[] = schema.children.map((child) => ({
      name: child.element.name,
      type: formatSchemaType(child.element as { type?: unknown; converted_type?: unknown; logical_type?: unknown }),
    }));

    return {
      uri,
      filePath,
      rowCount: Number(metadata.num_rows),
      columns,
    };
  }

  async getOriginalCodec(uri: vscode.Uri): Promise<string> {
    const { parquetMetadataAsync } = await loadHyparquet();
    const file = await loadFileBuffer(uri.fsPath);
    const metadata = await parquetMetadataAsync(file);
    const codec = metadata.row_groups?.[0]?.columns?.[0]?.meta_data?.codec;
    return mapCodecForDuckDb(codec);
  }

  async readPage(uri: vscode.Uri, rowStart: number, pageSize = DEFAULT_PAGE_SIZE): Promise<ParquetPage> {
    const info = await this.getFileInfo(uri);
    const rowEnd = Math.min(rowStart + pageSize, info.rowCount);
    const { parquetReadObjects } = await loadHyparquet();
    const compressors = await loadCompressors();
    const file = await loadFileBuffer(info.filePath);

    const columnNames = info.columns.map((c) => c.name);
    const rawRows =
      info.rowCount === 0
        ? []
        : await parquetReadObjects({
            file,
            compressors,
            columns: columnNames,
            rowStart,
            rowEnd,
          });

    return {
      rows: serializeRows(rawRows as Record<string, unknown>[]),
      rowStart,
      rowEnd,
      totalRows: info.rowCount,
      columns: info.columns,
    };
  }

  async readAllRows(uri: vscode.Uri, onProgress?: (loaded: number, total: number) => void): Promise<Record<string, unknown>[]> {
    const info = await this.getFileInfo(uri);
    const pageSize = 5000;
    const all: Record<string, unknown>[] = [];

    for (let start = 0; start < info.rowCount; start += pageSize) {
      const page = await this.readPage(uri, start, pageSize);
      all.push(...page.rows);
      onProgress?.(Math.min(start + pageSize, info.rowCount), info.rowCount);
    }

    return all;
  }

  async exportCsv(uri: vscode.Uri, targetUri: vscode.Uri): Promise<void> {
    const rows = await this.readAllRows(uri);
    const info = await this.getFileInfo(uri);
    const headers = info.columns.map((c) => c.name);
    const lines: string[] = [headers.map(escapeCsv).join(',')];

    for (const row of rows) {
      lines.push(headers.map((h) => escapeCsv(formatCell(row[h]))).join(','));
    }

    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(lines.join('\n'), 'utf8'));
  }

  async exportJson(uri: vscode.Uri, targetUri: vscode.Uri): Promise<void> {
    const rows = await this.readAllRows(uri);
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(JSON.stringify(rows, null, 2), 'utf8'));
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function pickParquetUri(resource?: vscode.Uri): vscode.Uri | undefined {
  if (resource?.fsPath.toLowerCase().endsWith('.parquet')) {
    return resource;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.fsPath.toLowerCase().endsWith('.parquet')) {
    return active;
  }
  return undefined;
}

export function defaultExportUri(source: vscode.Uri, extension: string): vscode.Uri {
  const base = path.basename(source.fsPath, '.parquet');
  return vscode.Uri.file(path.join(path.dirname(source.fsPath), `${base}${extension}`));
}

function mapCodecForDuckDb(codec: string | undefined): string {
  switch ((codec ?? '').toUpperCase()) {
    case 'UNCOMPRESSED':
      return 'uncompressed';
    case 'SNAPPY':
      return 'snappy';
    case 'GZIP':
      return 'gzip';
    case 'BROTLI':
      return 'brotli';
    case 'ZSTD':
      return 'zstd';
    case 'LZ4':
    case 'LZ4_RAW':
      return 'lz4_raw';
    default:
      return 'snappy';
  }
}
