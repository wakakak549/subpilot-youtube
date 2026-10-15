import { build } from 'esbuild';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = path.join(root, 'extension');
await mkdir(path.join(extension, 'vendor'), { recursive: true });
await mkdir(path.join(extension, 'icons'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'scripts/icons-entry.js')], bundle: true, format: 'iife',
  outfile: path.join(extension, 'vendor/icons.js'), minify: true, legalComments: 'eof',
});
await copyFile(path.join(root, 'node_modules/lucide/LICENSE'), path.join(extension, 'vendor/lucide.LICENSE'));
for (const size of [16, 48, 128]) {
  await access(path.join(extension, 'icons', `icon${size}.png`));
}
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
const files = [manifest.background.service_worker, manifest.options_ui.page, manifest.action.default_popup,
  ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(script => [...script.js, ...(script.css || [])])];
for (const file of files) await access(path.join(extension, file));
console.log(`Extension ${manifest.version} ready: ${extension}`);
