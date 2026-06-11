import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WebviewToExtensionMessage } from './types';
import { streamParseAndSend } from './webviewStream';

const FILE_SIZE_WARN_BYTES = 5 * 1024 * 1024;

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export class CompareViewProvider {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private loadSeq = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  createOrShowPanel(uri1: vscode.Uri, uri2: vscode.Uri): void {
    const key = uri1.fsPath + '|' + uri2.fsPath;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'tableDataViewCompare',
      `${path.basename(uri1.fsPath)} ↔ ${path.basename(uri2.fsPath)}`,
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out')],
        retainContextWhenHidden: true,
      }
    );

    this.panels.set(key, panel);
    panel.onDidDispose(() => this.panels.delete(key));

    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'compareWebview.js')
    );

    panel.webview.html = this.getWebviewContent(panel.webview, scriptUri);

    panel.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      if (msg.type === 'ready' || msg.type === 'reload') {
        this.loadFiles(panel, uri1, uri2);
      }
    });
  }

  private async loadFiles(panel: vscode.WebviewPanel, uri1: vscode.Uri, uri2: vscode.Uri): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      for (const uri of [uri1, uri2]) {
        const stat = await fs.promises.stat(uri.fsPath);
        if (stat.size > FILE_SIZE_WARN_BYTES) {
          vscode.window.showWarningMessage(
            `TableDataView: ${path.basename(uri.fsPath)} is ${(stat.size / 1024 / 1024).toFixed(1)} MB. Large files may render slowly.`
          );
        }
      }

      // Parse and stream one file at a time. streamParseAndSend keeps peak
      // memory to a single chunk's worth and yields to the event loop between
      // chunks, so even two large files do not block the extension host or
      // produce a webview message larger than V8's max string length (~512 MiB).
      let leftContent: string | null = await fs.promises.readFile(uri1.fsPath, 'utf-8');
      await streamParseAndSend(panel, leftContent, uri1.fsPath, 'left', seq);
      leftContent = null; // release the first file before reading the second

      const rightContent = await fs.promises.readFile(uri2.fsPath, 'utf-8');
      await streamParseAndSend(panel, rightContent, uri2.fsPath, 'right', seq);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      panel.webview.postMessage({ type: 'error', message: `Failed to read files: ${message}` });
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
  <title>TableDataView Compare</title>
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
    .file-name { font-weight: bold; margin-right: 2px; }
    .compare-sep { color: var(--vscode-descriptionForeground); margin: 0 2px; }
    #truncate-notice {
      color: var(--vscode-notificationsWarningIcon-foreground, orange);
      font-size: 0.85em;
    }
    .toolbar-sep { width: 1px; height: 16px; background: var(--vscode-panel-border); margin: 0 2px; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 2px 8px;
      cursor: pointer;
      font-size: 0.9em;
      border-radius: 2px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.4; cursor: default; }
    #btn-reset-all {
      margin-left: 14px;
      background: var(--vscode-inputValidation-warningBackground, #6b3600);
      color: var(--vscode-inputValidation-warningForeground, #fff);
    }
    #btn-reset-all:hover { background: var(--vscode-editorWarning-foreground, #b87000); }
    #compare-wrapper {
      display: flex;
      flex: 1;
      overflow: hidden;
      min-height: 0;
    }
    .pane {
      flex: 1;
      overflow: auto;
      min-width: 0;
    }
    #pane-divider {
      width: 4px;
      flex-shrink: 0;
      cursor: col-resize;
      background: var(--vscode-panel-border, #444);
    }
    #pane-divider:hover { background: var(--vscode-focusBorder, #007acc); }
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
    .col-index-row th {
      color: var(--vscode-descriptionForeground);
      font-size: 0.8em;
      font-weight: normal;
      top: 0;
    }
    .header-row th {
      top: var(--col-index-height, 0px);
    }
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
      width: 360px;
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
    #col-search-list { list-style: none; margin: 0; padding: 4px 0; max-height: 320px; overflow-y: auto; }
    #col-search-list li {
      display: flex;
      gap: 8px;
      align-items: baseline;
      padding: 4px 10px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #col-search-list li .col-side { font-size: 0.8em; font-weight: bold; min-width: 1.4em; }
    #col-search-list li .col-side.left { color: #4bc0c0; }
    #col-search-list li .col-side.right { color: #ff9f40; }
    #col-search-list li .col-num { color: var(--vscode-descriptionForeground, #888); font-size: 0.85em; min-width: 2.6em; text-align: right; }
    #col-search-list li:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08)); }
    #col-search-list li.selected { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); }
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
    td.col-has-diff { background: rgba(210, 60, 60, 0.35) !important; }
    th.col-has-diff { box-shadow: inset 0 0 0 9999px rgba(210, 60, 60, 0.35); }
    td.value-diff { background: rgba(210, 60, 60, 0.35) !important; }
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
    #graph-yvalues { flex: 1; font-size: 0.8em; white-space: nowrap; overflow-x: auto; min-width: 0; }
    #graph-resize-handle {
      height: 5px;
      cursor: ns-resize;
      background: var(--vscode-panel-border);
      flex-shrink: 0;
    }
    #graph-resize-handle:hover { background: var(--vscode-focusBorder, #007acc); }
    #chart-canvas { flex: 1; min-height: 0; cursor: crosshair; }
  </style>
</head>
<body>
  <div id="toolbar">
    <button id="btn-top">Top</button>
    <button id="btn-bottom">Bottom</button>
    <button id="btn-left">Left</button>
    <button id="btn-right">Right</button>
    <div class="toolbar-sep"></div>
    <button id="btn-show-graph" disabled>Show Graph</button>
    <button id="btn-reset-all" class="hidden">Reset All</button>
    <div class="toolbar-sep"></div>
    <span id="left-file-name" class="file-name"></span>
    <span class="compare-sep">↔</span>
    <span id="right-file-name" class="file-name"></span>
    <span id="truncate-notice" class="hidden"></span>
    <button id="btn-reload" style="margin-left:auto;">Reload</button>
  </div>

  <div id="compare-wrapper">
    <div id="left-pane" class="pane">
      <table id="left-table">
        <thead>
          <tr id="left-col-index-row" class="col-index-row"></tr>
          <tr id="left-header-row" class="header-row"></tr>
        </thead>
        <tbody id="left-data-body"></tbody>
      </table>
    </div>
    <div id="pane-divider"></div>
    <div id="right-pane" class="pane">
      <table id="right-table">
        <thead>
          <tr id="right-col-index-row" class="col-index-row"></tr>
          <tr id="right-header-row" class="header-row"></tr>
        </thead>
        <tbody id="right-data-body"></tbody>
      </table>
    </div>
  </div>

  <div id="loading-overlay">
    <div class="loading-spinner"></div>
    <div id="loading-text">로딩 중...</div>
  </div>

  <div id="cell-tooltip" class="hidden"></div>

  <div id="col-search" class="hidden">
    <input id="col-search-input" type="text" autocomplete="off" spellcheck="false" placeholder="Go to column…" />
    <ul id="col-search-list"></ul>
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
      <li id="ctx-diff-sep" class="ctx-separator hidden"></li>
      <li id="ctx-goto-next-diff" class="hidden">Go to next different row</li>
      <li id="ctx-goto-prev-diff" class="hidden">Go to prev. different row</li>
      <li id="ctx-goto-max-diff" class="hidden">Find max. difference row</li>
      <li id="ctx-stats-sep" class="ctx-separator hidden"></li>
      <li id="ctx-stats" class="hidden"></li>
    </ul>
  </div>

  <div id="graph-container" class="hidden">
    <div id="graph-resize-handle"></div>
    <div id="graph-header">
      <div id="graph-yvalues"></div>
      <button id="btn-hide-crosshair" class="hidden">Hide Crosshair</button>
      <label style="font-size:0.85em;display:flex;align-items:center;gap:4px;">
        Select
        <select id="sel-graph-mode" style="background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border);padding:1px 4px;font-size:1em;">
          <option value="original">original</option>
          <option value="L-R">L - R</option>
          <option value="R-L">R - L</option>
          <option value="|L-R|">|L - R|</option>
        </select>
      </label>
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
          <option value="none" selected>none</option>
          <option value="dot">.</option>
          <option value="circle">o</option>
        </select>
      </label>
      <button id="btn-close-graph">&#x2715; Close</button>
    </div>
    <div id="graph-yvalues" class="hidden"></div>
    <canvas id="chart-canvas"></canvas>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
