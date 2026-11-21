import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FormatInfo, WebviewToExtensionMessage } from './types';
import { streamParseAndSend } from './webviewStream';
import { saveGraphImage } from './saveImage';
import { StoredFormat, expandPresetFolder, findFormat, listFormats, mergeScaleOffset, newFormat, renameFormat, upsertPreset, writeFormat } from './presetStore';

const FILE_SIZE_WARN_BYTES = 5 * 1024 * 1024;

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class TableViewProvider {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  // Headers of the file loaded in each panel, for finding its format.
  private readonly panelHeaders = new Map<vscode.WebviewPanel, string[]>();
  private loadSeq = 0;
  // Source file of the table view focused last (see activeFileUri).
  private lastActiveUri: vscode.Uri | undefined;
  // Format-file reads/writes run one at a time so quick successive saves
  // (Scale/Offset edits) don't overwrite each other.
  private formatQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('tableDataView.presetFolder')) return;
      for (const panel of this.panels.values()) this.postFormatInfo(panel);
    }));
    // A format file edited by hand (Open format file) shows up in the
    // pull-downs once saved. Scale/Offset isn't re-applied to open tables.
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
      const folder = path.resolve(this.presetFolder());
      if (path.dirname(path.resolve(doc.uri.fsPath)) !== folder || !doc.uri.fsPath.toLowerCase().endsWith('.json')) return;
      for (const panel of this.panels.values()) this.postFormatInfo(panel);
    }));
  }

  createOrShowPanel(uri: vscode.Uri): void {
    const key = uri.fsPath;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'tableDataView',
      path.basename(uri.fsPath),
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out')],
        retainContextWhenHidden: true,
      }
    );

    this.panels.set(key, panel);
    this.lastActiveUri = uri;
    panel.onDidChangeViewState(e => { if (e.webviewPanel.active) this.lastActiveUri = uri; });
    panel.onDidDispose(() => {
      this.panels.delete(key);
      this.panelHeaders.delete(panel);
      if (this.lastActiveUri?.fsPath === key) this.lastActiveUri = undefined;
    });

    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview.js')
    );

    panel.webview.html = this.getWebviewContent(panel.webview, scriptUri);

    panel.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      if (msg.type === 'ready' || msg.type === 'reload') {
        this.loadFile(panel, uri);
      } else if (msg.type === 'saveGraphImage') {
        const base = path.basename(uri.fsPath, path.extname(uri.fsPath));
        saveGraphImage(msg.dataUrl, vscode.Uri.joinPath(uri, '..', `${base}_graph.png`));
      } else if (msg.type === 'notify') {
        if (msg.level === 'warning') vscode.window.showWarningMessage(`TableDataView: ${msg.message}`);
        else vscode.window.showInformationMessage(`TableDataView: ${msg.message}`);
      } else if (msg.type === 'formatInfoRequest') {
        this.postFormatInfo(panel);
      } else if (msg.type === 'saveScaleOffset') {
        const entries = msg.entries;
        this.withFormat(panel, uri, entries.some(e => e.scale !== 1 || e.offset !== 0), (stored, headers) => {
          mergeScaleOffset(stored.data, headers, entries);
          return true;
        });
      } else if (msg.type === 'saveSelection') {
        this.saveSelection(panel, uri, msg.columns);
      } else if (msg.type === 'deletePreset') {
        this.deletePreset(panel, uri, msg.name);
      } else if (msg.type === 'renamePreset') {
        this.renamePreset(panel, uri, msg.name);
      } else if (msg.type === 'movePreset') {
        this.movePreset(panel, uri, msg.name, msg.delta);
      } else if (msg.type === 'renameFormat') {
        this.renameFormat(panel, uri);
      } else if (msg.type === 'openFormatFile') {
        this.openFormatFile(panel);
      }
    });
  }

  // The file shown by the active table view, else by the one focused last. (A
  // webview tab's context menu doesn't tell the command which tab it was.)
  activeFileUri(): vscode.Uri | undefined {
    for (const [fsPath, panel] of this.panels) {
      if (panel.active) return vscode.Uri.file(fsPath);
    }
    return this.lastActiveUri;
  }

  // ---- File formats (Scale/Offset + selection presets) ----

  private presetFolder(): string {
    const raw = vscode.workspace.getConfiguration('tableDataView').get<string>('presetFolder') ?? '';
    return expandPresetFolder(raw, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.formatQueue.then(job, job);
    this.formatQueue = run.catch(() => undefined);
    return run;
  }

  private async currentFormat(panel: vscode.WebviewPanel): Promise<{ stored: StoredFormat; ratio: number } | null> {
    const headers = this.panelHeaders.get(panel);
    if (!headers) return null;
    const formats = await listFormats(this.presetFolder(), (file, why) =>
      console.warn(`TableDataView: skipped format file ${file}: ${why}`));
    return findFormat(formats, headers);
  }

  private postFormatInfo(panel: vscode.WebviewPanel, focus?: string): Promise<void> {
    return this.enqueue(async () => {
      const found = await this.currentFormat(panel);
      const info: FormatInfo = {
        format: found ? { name: found.stored.data.format.name, ratio: found.ratio } : null,
        scaleOffset: found?.stored.data.scaleOffset ?? [],
        presets: found?.stored.data.presets ?? [],
      };
      panel.webview.postMessage({ type: 'formatInfo', ...info, ...(focus !== undefined ? { focus } : {}) });
    });
  }

  // Runs `change` on the panel's format (created, named after the file, when
  // there is none yet and `create` is set) and writes it if `change` says so.
  private withFormat(
    panel: vscode.WebviewPanel, uri: vscode.Uri, create: boolean,
    change: (stored: StoredFormat, headers: string[]) => boolean | Promise<boolean>,
  ): Promise<void> {
    return this.enqueue(async () => {
      const headers = this.panelHeaders.get(panel);
      if (!headers) return;
      try {
        const found = await this.currentFormat(panel);
        if (!found && !create) return;
        const stored = found?.stored
          ?? newFormat(this.presetFolder(), headers, path.basename(uri.fsPath, path.extname(uri.fsPath)));
        if (!(await change(stored, headers))) return;
        await writeFormat(stored);
        // A new format changes what the toolbar shows (its name).
        if (!found) this.postFormatInfo(panel);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`TableDataView: could not save the format file: ${message}`);
      }
    });
  }

  private async saveSelection(panel: vscode.WebviewPanel, uri: vscode.Uri, columns: Array<{ header: string }>): Promise<void> {
    const found = await this.enqueue(() => this.currentFormat(panel));
    const existing = found?.stored.data.presets ?? [];
    const name = (await vscode.window.showInputBox({
      title: 'Save column selection',
      prompt: found ? `Preset name (format: ${found.stored.data.format.name})` : 'Preset name (a new format is created for this file)',
      value: `Selection ${existing.length + 1}`,
      validateInput: v => (v.trim() ? undefined : 'Enter a name'),
    }))?.trim();
    if (!name) return;
    if (existing.some(p => p.name === name)) {
      const ok = await vscode.window.showWarningMessage(
        `A preset named "${name}" already exists. Overwrite it?`, { modal: true }, 'Overwrite');
      if (ok !== 'Overwrite') return;
    }
    await this.withFormat(panel, uri, true, stored => {
      upsertPreset(stored.data, { name, savedAt: Date.now(), columns });
      return true;
    });
    await this.postFormatInfo(panel, name);
  }

  // name omitted: let the user pick the selection to delete.
  private async deletePreset(panel: vscode.WebviewPanel, uri: vscode.Uri, name?: string): Promise<void> {
    if (name === undefined) {
      const found = await this.enqueue(() => this.currentFormat(panel));
      const presets = found?.stored.data.presets ?? [];
      if (presets.length === 0) {
        vscode.window.showInformationMessage('TableDataView: this format has no saved selections.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        presets.map(p => ({ label: p.name, description: p.columns.map(c => c.header).join(', ') })),
        { title: `Delete a column selection (format: ${found!.stored.data.format.name})` });
      if (!pick) return;
      name = pick.label;
    }
    const target = name;
    const ok = await vscode.window.showWarningMessage(`Delete selection "${target}"?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    await this.withFormat(panel, uri, false, stored => {
      const before = stored.data.presets.length;
      stored.data.presets = stored.data.presets.filter(p => p.name !== target);
      return stored.data.presets.length !== before;
    });
    await this.postFormatInfo(panel);
  }

  private async renamePreset(panel: vscode.WebviewPanel, uri: vscode.Uri, name: string): Promise<void> {
    const found = await this.enqueue(() => this.currentFormat(panel));
    const others = (found?.stored.data.presets ?? []).map(p => p.name).filter(n => n !== name);
    const next = (await vscode.window.showInputBox({
      title: `Rename selection "${name}"`,
      value: name,
      validateInput: v => {
        const t = v.trim();
        if (!t) return 'Enter a name';
        return others.includes(t) ? `A selection named "${t}" already exists` : undefined;
      },
    }))?.trim();
    if (!next || next === name) return;
    await this.withFormat(panel, uri, false, stored => {
      const p = stored.data.presets.find(x => x.name === name);
      if (!p || stored.data.presets.some(x => x.name === next)) return false;
      p.name = next;
      return true;
    });
    await this.postFormatInfo(panel, next);
  }

  // Renames the file's format; a file with no format yet gets one under the
  // entered name (and its .json file is written right away).
  private async renameFormat(panel: vscode.WebviewPanel, uri: vscode.Uri): Promise<void> {
    const found = await this.enqueue(() => this.currentFormat(panel));
    const old = found?.stored.data.format.name;
    const next = (await vscode.window.showInputBox({
      title: old !== undefined ? `Rename format "${old}"` : 'Name the format of this file',
      prompt: old !== undefined ? undefined : 'A format file is created for files with these headers.',
      value: old ?? path.basename(uri.fsPath, path.extname(uri.fsPath)),
      validateInput: v => (v.trim() ? undefined : 'Enter a name'),
    }))?.trim();
    if (!next || next === old) return;
    await this.enqueue(async () => {
      try {
        // Re-read: the file may have changed while the input box was open.
        const cur = await this.currentFormat(panel);
        if (cur) {
          await renameFormat(cur.stored, next);
        } else {
          const headers = this.panelHeaders.get(panel);
          if (!headers) return;
          await writeFormat(newFormat(this.presetFolder(), headers, next));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`TableDataView: could not rename the format: ${message}`);
      }
    });
    // Other open files of this format show its name too.
    for (const p of this.panels.values()) this.postFormatInfo(p);
  }

  private async openFormatFile(panel: vscode.WebviewPanel): Promise<void> {
    const found = await this.enqueue(() => this.currentFormat(panel));
    if (!found) return;
    await vscode.window.showTextDocument(vscode.Uri.file(found.stored.file), { preview: false });
  }

  // Moves a selection one place up (-1) or down (+1) in the pull-down.
  private async movePreset(panel: vscode.WebviewPanel, uri: vscode.Uri, name: string, delta: -1 | 1): Promise<void> {
    await this.withFormat(panel, uri, false, stored => {
      const list = stored.data.presets;
      const i = list.findIndex(p => p.name === name);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return false;
      [list[i], list[j]] = [list[j], list[i]];
      return true;
    });
    await this.postFormatInfo(panel, name);
  }

  private async loadFile(panel: vscode.WebviewPanel, uri: vscode.Uri): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      const stat = await fs.promises.stat(uri.fsPath);
      if (stat.size > FILE_SIZE_WARN_BYTES) {
        vscode.window.showWarningMessage(
          `TableDataView: File is ${(stat.size / 1024 / 1024).toFixed(1)} MB. Large files may render slowly.`
        );
      }

      // Async read so the extension host is not blocked while the (possibly
      // hundreds of MB) file is loaded; streamParseAndSend then parses and
      // streams it incrementally, yielding between chunks.
      const content = await fs.promises.readFile(uri.fsPath, 'utf-8');
      const headers = await streamParseAndSend(panel, content, uri.fsPath, 'single', seq);
      this.panelHeaders.set(panel, headers);
      await this.postFormatInfo(panel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      panel.webview.postMessage({ type: 'error', message: `Failed to read file: ${message}` });
    }
  }

  private getWebviewContent(_webview: vscode.Webview, scriptUri: vscode.Uri): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}'`,
      `style-src 'unsafe-inline'`,
      `img-src data: blob:`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TableDataView</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    #toolbar {
      position: sticky;
      top: 0;
      background: var(--vscode-titleBar-activeBackground, #333);
      padding: 4px 8px;
      display: flex;
      gap: 6px;
      align-items: center;
      flex-shrink: 0;
      z-index: 10;
      flex-wrap: wrap;
    }
    #file-name { font-weight: bold; margin-right: 4px; }
    #truncate-notice {
      color: var(--vscode-notificationsWarningIcon-foreground, orange);
      font-size: 0.85em;
    }
    .toolbar-sep { width: 1px; height: 16px; background: var(--vscode-panel-border); margin: 0 2px; }
    button {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-focusBorder, #007acc);
      padding: 3px 12px;
      cursor: pointer;
      font-size: 0.9em;
      border-radius: 6px;
      transition: background 0.12s, color 0.12s;
    }
    button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.06)); }
    button:disabled { opacity: 0.4; cursor: default; }
    button.active {
      border-color: var(--vscode-focusBorder, #007acc);
      background: var(--vscode-list-activeSelectionBackground, rgba(0,122,204,0.2));
      color: var(--vscode-focusBorder, #007acc);
    }
    #btn-reset-all {
      margin-left: 14px;
      border-color: var(--vscode-inputValidation-warningBorder, #b87000);
      background: var(--vscode-inputValidation-warningBackground, #6b3600);
      color: var(--vscode-inputValidation-warningForeground, #fff);
    }
    #sel-preset {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-focusBorder, #007acc);
      border-radius: 6px;
      padding: 2px 6px;
      font-size: 0.9em;
      max-width: 260px;
      cursor: pointer;
    }
    #btn-reset-all:hover { background: var(--vscode-editorWarning-foreground, #b87000); }
    #main-row {
      flex: 1;
      display: flex;
      overflow: hidden;
      min-height: 0;
    }
    #header-panel {
      width: fit-content;
      min-width: 140px;
      max-width: 50vw;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      background: var(--vscode-editorWidget-background, #252526);
      border-left: 1px solid var(--vscode-panel-border, #444);
    }
    #header-panel-title {
      padding: 8px 10px;
      font-weight: bold;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground, #aaa);
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      flex-shrink: 0;
    }
    #header-panel-list { flex: 1; overflow-y: auto; }
    #table-container {
      overflow: auto;
      flex: 1;
      min-height: 0;
    }
    table {
      border-collapse: separate;
      border-spacing: 0;
      width: max-content;
      min-width: 100%;
    }
    th, td {
      padding: 3px 10px;
      border-right: 1px solid var(--vscode-panel-border, #444);
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
      user-select: none;
    }
    th:first-child, td:first-child {
      border-left: 1px solid var(--vscode-panel-border, #444);
    }
    thead th {
      border-top: 1px solid var(--vscode-panel-border, #444);
    }
    th {
      background: var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d);
      position: sticky;
      top: 0;
      z-index: 5;
    }
    #col-index-row th {
      color: var(--vscode-descriptionForeground);
      font-size: 0.8em;
      font-weight: normal;
      text-align: left;
      top: 0;
    }
    #header-row th {
      top: var(--col-index-height, 0px);
    }
    #scale-row th  { top: var(--scale-row-top, 0px); }
    #offset-row th { top: var(--offset-row-top, 0px); }
    #scale-row th, #offset-row th { padding: 1px 4px; }
    th.so-label {
      font-size: 0.75em;
      font-weight: normal;
      color: var(--vscode-descriptionForeground);
      cursor: default;
    }
    .so-input {
      width: 100%;
      box-sizing: border-box;
      padding: 0 4px;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      outline: none;
      font-family: inherit;
      font-size: 0.85em;
      text-align: right;
      cursor: text;
      user-select: text;
    }
    .so-input:focus { border-color: var(--vscode-focusBorder, #007acc); }
    .so-input.modified { color: #d8a0e0; font-weight: bold; }
    th.selected {
      background: var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d);
      box-shadow: inset 0 0 0 9999px var(--vscode-list-activeSelectionBackground, rgba(0,122,204,0.4));
      color: var(--vscode-editor-foreground, var(--vscode-foreground));
      font-weight: bold;
    }
    td.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .row-num-cell {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      cursor: default;
      width: var(--row-num-width, 40px);
      min-width: var(--row-num-width, 40px);
      max-width: var(--row-num-width, 40px);
      overflow: hidden;
      position: sticky;
      left: 0;
      z-index: 3;
      background: var(--vscode-editor-background, #1e1e1e);
    }
    th.row-num-cell {
      background: var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d);
      z-index: 7;
    }
    .col-first {
      position: sticky;
      left: var(--row-num-width, 60px);
      z-index: 2;
      overflow: hidden;
      text-overflow: ellipsis;
      background: var(--vscode-editor-background, #1e1e1e);
      width: var(--col-first-width, 120px);
      min-width: var(--col-first-width, 120px);
      max-width: var(--col-first-width, 120px);
    }
    th.col-first {
      background: var(--vscode-editorGroupHeader-tabsBackground, #2d2d2d);
      z-index: 6;
    }
    td.col-first.selected {
      background: var(--vscode-editor-background, #1e1e1e);
      box-shadow: inset 0 0 0 9999px var(--vscode-list-activeSelectionBackground, rgba(0,122,204,0.4));
      color: var(--vscode-list-activeSelectionForeground);
    }
    .align-left   { text-align: left; }
    .align-center { text-align: center; }
    .align-right  { text-align: right; }
    .hidden { display: none !important; }
    .error-message {
      padding: 16px;
      color: var(--vscode-errorForeground, #f44);
    }
    #loading-overlay {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      background: var(--vscode-editor-background);
      color: var(--vscode-descriptionForeground, #aaa);
    }
    .loading-spinner {
      width: 36px;
      height: 36px;
      border: 4px solid var(--vscode-panel-border, #444);
      border-top-color: var(--vscode-progressBar-background, #007acc);
      border-radius: 50%;
      animation: tdv-spin 0.8s linear infinite;
    }
    @keyframes tdv-spin { to { transform: rotate(360deg); } }
    #loading-text { font-size: 0.95em; }
    #cell-tooltip {
      position: fixed;
      z-index: 200;
      max-width: 640px;
      padding: 3px 8px;
      background: #ffd866;
      color: #1e1e1e;
      border: 1px solid #b8860b;
      border-radius: 3px;
      font-size: 0.9em;
      font-weight: 600;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      pointer-events: none;
      box-shadow: 0 2px 10px rgba(0,0,0,0.55);
    }
    #col-search {
      position: fixed;
      top: 44px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 150;
      width: 340px;
      max-width: 80%;
      display: flex;
      flex-direction: column;
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-focusBorder, #007acc);
      border-radius: 4px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      overflow: hidden;
    }
    #col-search-input {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 9px;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: none;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      outline: none;
      font-family: inherit;
      font-size: 1em;
    }
    #col-search-list { max-height: 320px; overflow-y: auto; }
    .col-list { list-style: none; margin: 0; padding: 4px 0; }
    .col-list li {
      display: flex;
      gap: 8px;
      align-items: baseline;
      padding: 4px 10px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      user-select: none;
    }
    .col-list li .col-num { color: var(--vscode-descriptionForeground, #888); font-size: 0.85em; min-width: 2.6em; text-align: right; }
    .col-list li .col-name { overflow: hidden; text-overflow: ellipsis; }
    .col-list li:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08)); }
    .col-list li.selected { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); }
    .col-list li.x-axis { color: #ff8c00; font-weight: bold; }
    #col-search-empty { padding: 6px 10px; color: var(--vscode-descriptionForeground, #888); font-style: italic; }
    @keyframes tdv-col-flash {
      from { box-shadow: inset 0 0 0 9999px rgba(255,200,50,0.55); }
      to   { box-shadow: inset 0 0 0 9999px rgba(255,200,50,0); }
    }
    th.col-flash { animation: tdv-col-flash 1s ease-out; }
    td.crosshair-row {
      outline: 2px solid var(--vscode-focusBorder, #007acc);
      outline-offset: -2px;
    }
    #context-menu {
      position: fixed;
      background: var(--vscode-menu-background, #252526);
      border: 1px solid var(--vscode-menu-border, #454545);
      z-index: 100;
      min-width: 140px;
      padding: 4px 0;
    }
    #context-menu ul { margin: 0; padding: 0; }
    #context-menu li {
      padding: 5px 16px;
      cursor: pointer;
      list-style: none;
      color: var(--vscode-menu-foreground);
      font-size: 0.9em;
    }
    #context-menu li:hover { background: var(--vscode-menu-selectionBackground); }
    .ctx-separator { height: 1px; background: var(--vscode-menu-border, #454545); margin: 4px 0; padding: 0; cursor: default; pointer-events: none; }
    .ctx-separator:hover { background: var(--vscode-menu-border, #454545); }
    #ctx-stats { cursor: default; color: var(--vscode-descriptionForeground, #888); font-size: 0.82em; white-space: nowrap; line-height: 1.6; }
    #ctx-stats:hover { background: transparent; }
    th.x-axis {
      box-shadow: inset 0 0 0 9999px rgba(255,140,0,0.35);
      color: var(--vscode-editor-foreground, var(--vscode-foreground));
      font-weight: bold;
    }
    td.x-axis {
      box-shadow: inset 0 0 0 9999px rgba(255,140,0,0.25);
      color: var(--vscode-editor-foreground, var(--vscode-foreground));
    }
    th.diff-col { color: #7ec8a0; }
    td.diff-col { color: #7ec8a0; }
    th.movavg-col { color: #7ec8e8; }
    td.movavg-col { color: #7ec8e8; }
    th.hex-col { color: #e8c87e; }
    td.hex-col { color: #e8c87e; }
    th.scaled-col { color: #d8a0e0; }
    td.scaled-col { color: #d8a0e0; }
    #graph-container {
      flex-shrink: 0;
      height: 42vh;
      background: var(--vscode-editor-background);
      border-top: 2px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
    }
    #graph-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      background: var(--vscode-titleBar-activeBackground, #333);
      flex-shrink: 0;
    }
    #graph-header { position: relative; }
    #graph-save-popover {
      position: absolute; right: 8px; top: 100%; z-index: 200;
      display: flex; flex-direction: column; gap: 6px;
      padding: 8px 10px; min-width: 230px;
      background: var(--vscode-menu-background, #252526);
      color: var(--vscode-menu-foreground, inherit);
      border: 1px solid var(--vscode-menu-border, #454545);
      box-shadow: 0 2px 8px rgba(0,0,0,0.35);
      font-size: 0.85em;
    }
    #graph-save-popover.hidden { display: none; }
    #graph-save-popover label { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    #graph-save-popover label.chk { justify-content: flex-start; }
    #graph-save-popover select {
      background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border); padding: 1px 4px; font-size: 1em;
    }
    #graph-save-popover .buttons { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }
    #graph-yvalues { flex: 1; font-size: 0.8em; white-space: nowrap; overflow-x: auto; min-width: 0; }
    #graph-resize-handle {
      height: 5px;
      cursor: ns-resize;
      background: var(--vscode-panel-border);
      flex-shrink: 0;
    }
    #graph-resize-handle:hover { background: var(--vscode-focusBorder, #007acc); }
    #chart-canvas-wrapper { flex: 1; min-height: 0; overflow: hidden; }
    #chart-canvas { width: 100%; height: 100%; cursor: crosshair; }
    #fft-divider { height: 4px; cursor: ns-resize; background: var(--vscode-panel-border); flex-shrink: 0; }
    #fft-divider:hover { background: var(--vscode-focusBorder, #007acc); }
    #fft-yvalues { padding: 2px 8px; font-size: 0.8em; white-space: nowrap; overflow-x: auto; flex-shrink: 0; line-height: 20px; border-bottom: 1px solid var(--vscode-panel-border); }
    #fft-canvas-wrapper { flex-shrink: 0; min-height: 60px; overflow: hidden; }
    #fft-canvas { width: 100%; height: 100%; cursor: crosshair; }
  </style>
</head>
<body>
  <div id="toolbar">
    <button id="btn-top">Top</button>
    <button id="btn-bottom">Bottom</button>
    <button id="btn-left">Left</button>
    <button id="btn-right">Right</button>
    <div class="toolbar-sep"></div>
    <button id="btn-scale-offset" title="Show the per-column scale and offset rows">Scale/Offset</button>
    <button id="btn-show-graph" disabled>Graph</button>
    <button id="btn-reset-all" class="hidden">Reset All</button>
    <select id="sel-preset"></select>
    <div class="toolbar-sep"></div>
    <span id="file-name"></span>
    <span id="truncate-notice" class="hidden"></span>
    <button id="btn-reload" style="margin-left:auto;">&#x21bb; Reload</button>
    <button id="btn-toggle-header" class="active" title="Show column list">&#x2630; Header</button>
  </div>

  <div id="main-row">
    <div id="table-container">
      <table id="data-table">
        <thead>
          <tr id="col-index-row"></tr>
          <tr id="header-row"></tr>
          <tr id="scale-row"></tr>
          <tr id="offset-row"></tr>
        </thead>
        <tbody id="data-body"></tbody>
      </table>
    </div>

    <div id="header-panel">
      <div id="header-panel-title">Columns</div>
      <ul id="header-panel-list" class="col-list"></ul>
    </div>
  </div>

  <div id="loading-overlay">
    <div class="loading-spinner"></div>
    <div id="loading-text">로딩 중...</div>
  </div>

  <div id="cell-tooltip" class="hidden"></div>

  <div id="col-search" class="hidden">
    <input id="col-search-input" type="text" autocomplete="off" spellcheck="false" placeholder="Go to column…" />
    <ul id="col-search-list" class="col-list"></ul>
  </div>

  <div id="context-menu" class="hidden">
    <ul>
      <li id="ctx-reset-xaxis">Reset x-axis</li>
      <li id="ctx-set-xaxis">Set as x-axis</li>
      <li id="ctx-show-hex">Show in hex</li>
      <li id="ctx-show-diff">Show numerical differences</li>
      <li id="ctx-show-movavg-10">Show moving averages (n=10)</li>
      <li id="ctx-show-movavg-30">Show moving averages (n=30)</li>
      <li id="ctx-show-movavg-100">Show moving averages (n=100)</li>
      <li id="ctx-show-movavg-1000">Show moving averages (n=1000)</li>
      <li id="ctx-show-original">Show original values</li>
      <li id="ctx-find-change-sep" class="ctx-separator hidden"></li>
      <li id="ctx-find-prev-change" class="hidden">Find prev. change</li>
      <li id="ctx-find-next-change" class="hidden">Find next change</li>
      <li id="ctx-goto-max" class="hidden">Go to max. value</li>
      <li id="ctx-goto-min" class="hidden">Go to min. value</li>
      <li id="ctx-goto-prev-nan" class="hidden">Go to prev. NaN</li>
      <li id="ctx-goto-next-nan" class="hidden">Go to next NaN</li>
      <li id="ctx-stats-sep" class="ctx-separator hidden"></li>
      <li id="ctx-stats" class="hidden"></li>
    </ul>
  </div>

  <div id="graph-container" class="hidden">
    <div id="graph-resize-handle"></div>
    <div id="graph-header">
      <div id="graph-yvalues"></div>
      <button id="btn-hide-crosshair" class="hidden">Hide Crosshair</button>
      <button id="btn-show-fft">Show FFT</button>
      <div style="width:16px;flex-shrink:0;"></div>
      <label style="font-size:0.85em;display:flex;align-items:center;gap:4px;">
        Line width
        <select id="sel-line-width" style="background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);padding:1px 4px;font-size:1em;">
          <option value="0.5">0.5</option>
          <option value="1" selected>1.0</option>
          <option value="1.5">1.5</option>
          <option value="2">2.0</option>
          <option value="3">3.0</option>
        </select>
      </label>
      <label style="font-size:0.85em;display:flex;align-items:center;gap:4px;">
        Marker
        <select id="sel-marker" style="background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);padding:1px 4px;font-size:1em;">
          <option value="none">none</option>
          <option value="dot" selected>.</option>
          <option value="circle">o</option>
        </select>
      </label>
      <button id="btn-save-graph" title="Save graph as PNG">Save</button>
      <button id="btn-close-graph" title="Close graph">&#x2715;</button>
      <div id="graph-save-popover" class="hidden">
        <label>Size
          <select id="sel-save-size">
            <option value="current" selected>Current view</option>
            <option value="in8x6">8 × 6 in (150 dpi)</option>
          </select>
        </label>
        <label>Legend
          <select id="sel-save-legend">
            <option value="top" selected>Top</option>
            <option value="right">Right</option>
            <option value="left">Left</option>
            <option value="bottom">Bottom</option>
          </select>
        </label>
        <label class="chk"><input type="checkbox" id="chk-save-minimap"> Show minimap</label>
        <div class="buttons">
          <button id="btn-save-graph-cancel">Cancel</button>
          <button id="btn-save-graph-ok">Save…</button>
        </div>
      </div>
    </div>
    <div id="chart-canvas-wrapper"><canvas id="chart-canvas"></canvas></div>
    <div id="fft-divider" class="hidden"></div>
    <div id="fft-yvalues" class="hidden"></div>
    <div id="fft-canvas-wrapper" class="hidden"><canvas id="fft-canvas"></canvas></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
