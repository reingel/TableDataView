import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FormatFile, ScaleOffsetEntry, SelectionPreset } from './types';
import { FORMAT_MATCH_RATIO, formatMatchRatio, matchHeader } from './presetMatch';

// File formats live as one JSON file each in the preset folder
// (tableDataView.presetFolder). Everything here works on a folder path so it
// can be exercised without VS Code; tableViewProvider supplies the folder.

export const DEFAULT_PRESET_FOLDER = path.join(os.homedir(), '.tabledataview', 'presets');

// The setting's value with ~ and ${workspaceFolder} expanded. Empty, or a
// ${workspaceFolder} path with no workspace open, falls back to the default.
export function expandPresetFolder(raw: string, workspaceFolder: string | undefined): string {
  let p = raw.trim();
  if (!p) return DEFAULT_PRESET_FOLDER;
  if (p.includes('${workspaceFolder}')) {
    if (!workspaceFolder) return DEFAULT_PRESET_FOLDER;
    p = p.split('${workspaceFolder}').join(workspaceFolder);
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

export type StoredFormat = { file: string; data: FormatFile };

function isFormatFile(v: unknown): v is FormatFile {
  const f = v as FormatFile;
  return !!f && typeof f === 'object'
    && !!f.format && typeof f.format.name === 'string' && Array.isArray(f.format.headers)
    && Array.isArray(f.scaleOffset) && Array.isArray(f.presets);
}

// Every readable format file in the folder. Unreadable or malformed files are
// skipped (reported through onSkip), never fatal.
export async function listFormats(folder: string, onSkip?: (file: string, why: string) => void): Promise<StoredFormat[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(folder);
  } catch {
    return [];
  }
  const out: StoredFormat[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const file = path.join(folder, name);
    try {
      const data = JSON.parse(await fs.promises.readFile(file, 'utf-8'));
      if (isFormatFile(data)) out.push({ file, data });
      else onSkip?.(file, 'not a TableDataView format file');
    } catch (err) {
      onSkip?.(file, err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

// The format the headers belong to: the best match at or above
// FORMAT_MATCH_RATIO, else null.
export function findFormat(formats: StoredFormat[], headers: string[]): { stored: StoredFormat; ratio: number } | null {
  let best: { stored: StoredFormat; ratio: number } | null = null;
  for (const stored of formats) {
    const ratio = formatMatchRatio(stored.data.format.headers, headers);
    if (ratio >= FORMAT_MATCH_RATIO && (!best || ratio > best.ratio)) best = { stored, ratio };
  }
  return best;
}

function safeFileName(name: string): string {
  return name.replace(/[^\w가-힣.-]/g, '_').replace(/^\.+/, '') || 'format';
}

// A new, empty format for these headers, named after the file (a numbered
// suffix keeps it from overwriting another format's file). Not written yet.
export function newFormat(folder: string, headers: string[], fileBaseName: string): StoredFormat {
  const base = safeFileName(fileBaseName);
  let file = path.join(folder, `${base}.json`);
  for (let k = 2; fs.existsSync(file); k++) file = path.join(folder, `${base}_${k}.json`);
  return {
    file,
    data: { version: 1, format: { name: fileBaseName, headers: headers.slice() }, scaleOffset: [], presets: [] },
  };
}

// Renames the format, and its file to match when that file name is free (else
// the file keeps its name — only the name inside changes). Writes it.
export async function renameFormat(stored: StoredFormat, name: string): Promise<void> {
  stored.data.format.name = name;
  await writeFormat(stored);
  const target = path.join(path.dirname(stored.file), `${safeFileName(name)}.json`);
  if (target === stored.file || fs.existsSync(target)) return;
  await fs.promises.rename(stored.file, target);
  stored.file = target;
}

export async function writeFormat(stored: StoredFormat): Promise<void> {
  await fs.promises.mkdir(path.dirname(stored.file), { recursive: true });
  await fs.promises.writeFile(stored.file, JSON.stringify(stored.data, null, 2) + '\n', 'utf-8');
}

// Replace the saved Scale/Offset of the file's columns with `entries` (one per
// uniquely named column of the file). Saved entries that refer to no column of
// this file are kept, so a file missing some channels doesn't erase their
// values; identity values (1 / 0) aren't stored.
export function mergeScaleOffset(data: FormatFile, fileHeaders: string[], entries: ScaleOffsetEntry[]): void {
  const kept = data.scaleOffset.filter(e => typeof matchHeader(e.header, fileHeaders) !== 'number');
  const fresh = entries.filter(e => e.scale !== 1 || e.offset !== 0)
    .map(e => ({ header: e.header, scale: e.scale, offset: e.offset }));
  data.scaleOffset = [...kept, ...fresh];
}

// Overwriting a selection keeps its y-axis title unless a new one is given.
export function upsertPreset(data: FormatFile, preset: SelectionPreset): void {
  const i = data.presets.findIndex(p => p.name === preset.name);
  if (i < 0) {
    data.presets.push(preset);
    return;
  }
  const yLabel = preset.yLabel ?? data.presets[i].yLabel;
  data.presets[i] = yLabel !== undefined ? { ...preset, yLabel } : preset;
}

export function setXLabel(data: FormatFile, key: string, label: string): void {
  const map = { ...(data.xLabels ?? {}) };
  if (label) map[key] = label;
  else delete map[key];
  if (Object.keys(map).length > 0) data.xLabels = map;
  else delete data.xLabels;
}
