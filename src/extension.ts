import * as path from 'path';
import * as vscode from 'vscode';
import { TableViewProvider } from './tableViewProvider';
import { CompareViewProvider } from './compareViewProvider';

const DATA_EXTS = ['.csv', '.tsv', '.txt', '.dat'];

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TableViewProvider(context);
  const compareProvider = new CompareViewProvider(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('tableDataView.openTableView', (uri?: vscode.Uri) => {
      if (!uri) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showErrorMessage('No file selected.');
          return;
        }
        uri = editor.document.uri;
      }
      provider.createOrShowPanel(uri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tableDataView.compareFiles', async (clicked?: vscode.Uri, all?: vscode.Uri[]) => {
      const files = (all ?? (clicked ? [clicked] : [])).filter(u =>
        DATA_EXTS.includes(path.extname(u.fsPath).toLowerCase())
      );
      if (files.length === 1) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: 'Select as Left File',
          title: 'Select the left file to compare against',
          filters: { 'Data files': DATA_EXTS.map(ext => ext.slice(1)) },
        });
        if (!picked || picked.length === 0) {
          return;
        }
        compareProvider.createOrShowPanel(picked[0], files[0]);
        return;
      }
      if (files.length === 0) {
        vscode.window.showInformationMessage('TableDataView: select a data file, then right-click to compare.');
        return;
      }
      if (files.length > 2) {
        vscode.window.showErrorMessage('TableDataView: Select exactly 2 data files to compare.');
        return;
      }
      compareProvider.createOrShowPanel(files[0], files[1]);
    })
  );
}

export function deactivate(): void {}
