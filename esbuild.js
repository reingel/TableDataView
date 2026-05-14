const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

const commonOptions = {
  bundle: true,
  minify: isProduction,
  sourcemap: !isProduction,
};

const extensionOptions = {
  ...commonOptions,
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  format: 'cjs',
  platform: 'node',
  external: ['vscode'],
};

const webviewOptions = {
  ...commonOptions,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'out/webview.js',
  format: 'iife',
  platform: 'browser',
};

const compareWebviewOptions = {
  ...commonOptions,
  entryPoints: ['src/webview/compareMain.ts'],
  outfile: 'out/compareWebview.js',
  format: 'iife',
  platform: 'browser',
};

async function build() {
  if (isWatch) {
    const [extCtx, webCtx, cmpCtx] = await Promise.all([
      esbuild.context(extensionOptions),
      esbuild.context(webviewOptions),
      esbuild.context(compareWebviewOptions),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch(), cmpCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionOptions),
      esbuild.build(webviewOptions),
      esbuild.build(compareWebviewOptions),
    ]);
    console.log('Build complete.');
  }
}

build().catch(() => process.exit(1));
