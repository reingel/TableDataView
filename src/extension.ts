import * as vscode from 'vscode';
import { TableViewProvider } from './tableViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TableViewProvider(context);

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
}

export function deactivate(): void {}
