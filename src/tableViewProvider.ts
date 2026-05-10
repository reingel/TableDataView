import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseFile } from './csvParser';
import { WebviewToExtensionMessage } from './types';

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

  constructor(private readonly context: vscode.ExtensionContext) {}

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
    panel.onDidDispose(() => this.panels.delete(key));

    const scriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview.js')
    );

    panel.webview.html = this.getWebviewContent(panel.webview, scriptUri);

    panel.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      if (msg.type === 'ready') {
        this.loadFile(panel, uri);
      }
    });
  }

  private loadFile(panel: vscode.WebviewPanel, uri: vscode.Uri): void {
    try {
      const stat = fs.statSync(uri.fsPath);
      if (stat.size > FILE_SIZE_WARN_BYTES) {
        vscode.window.showWarningMessage(
          `TableDataView: File is ${(stat.size / 1024 / 1024).toFixed(1)} MB. Large files may render slowly.`
        );
      }

      const content = fs.readFileSync(uri.fsPath, 'utf-8');
      const parsed = parseFile(content, uri.fsPath);
      panel.webview.postMessage({ type: 'loadData', payload: parsed });
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
    #delimiter-info { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-right: 8px; }
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
      top: 0;
    }
    #header-row th {
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
    #graph-title { flex: 1; font-weight: bold; }
    #graph-resize-handle {
      height: 5px;
      cursor: ns-resize;
      background: var(--vscode-panel-border);
      flex-shrink: 0;
    }
    #graph-resize-handle:hover { background: var(--vscode-focusBorder, #007acc); }
    #graph-yvalues {
      padding: 2px 8px;
      font-size: 0.8em;
      white-space: nowrap;
      overflow-x: auto;
      flex-shrink: 0;
      line-height: 20px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    #chart-canvas { flex: 1; min-height: 0; cursor: crosshair; }
  </style>
</head>
<body>
  <div id="toolbar">
    <span id="file-name"></span>
    <span id="delimiter-info"></span>
    <span id="truncate-notice" class="hidden"></span>
    <div class="toolbar-sep"></div>
    <button id="btn-top">Top</button>
    <button id="btn-bottom">Bottom</button>
    <button id="btn-left">Left</button>
    <button id="btn-right">Right</button>
    <div class="toolbar-sep"></div>
    <button id="btn-show-graph" disabled>Show Graph</button>
    <button id="btn-reset-all" class="hidden">Reset All</button>
  </div>

  <div id="table-container">
    <table id="data-table">
      <thead>
        <tr id="col-index-row"></tr>
        <tr id="header-row"></tr>
      </thead>
      <tbody id="data-body"></tbody>
    </table>
  </div>

  <div id="context-menu" class="hidden">
    <ul>
      <li id="ctx-reset-xaxis">Reset x-axis</li>
      <li id="ctx-set-xaxis">Set as x-axis</li>
      <li id="ctx-show-diff">Show numerical differences</li>
      <li id="ctx-show-original">Show original values</li>
    </ul>
  </div>

  <div id="graph-container" class="hidden">
    <div id="graph-resize-handle"></div>
    <div id="graph-header">
      <span id="graph-title">Graph</span>
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
