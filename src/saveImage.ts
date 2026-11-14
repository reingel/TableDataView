import * as path from 'path';
import * as vscode from 'vscode';

// Asks where to save the graph PNG rendered by the webview and writes it.
export async function saveGraphImage(dataUrl: string, defaultUri: vscode.Uri): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { 'PNG image': ['png'] },
    title: 'Save graph',
  });
  if (!target) return;
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  await vscode.workspace.fs.writeFile(target, Buffer.from(b64, 'base64'));
  vscode.window.showInformationMessage(`TableDataView: graph saved to ${path.basename(target.fsPath)}`);
}
