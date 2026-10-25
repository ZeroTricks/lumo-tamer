/**
 * Infer a safe command to run after files were written.
 */

import { basename, extname } from 'path';

const OPEN_HTML = process.platform === 'darwin'
  ? 'open'
  : process.platform === 'win32'
    ? 'start'
    : 'xdg-open';

export function inferRunCommand(files: string[]): string | undefined {
  const unique = [...new Set(files.filter(Boolean))];
  if (unique.length === 0) return undefined;

  const html = unique.find((file) => extname(file).toLowerCase() === '.html');
  if (html) {
    return `${OPEN_HTML} ${shellSingle(html)}`;
  }

  const py = unique.find((file) => extname(file).toLowerCase() === '.py');
  if (py) {
    return `python3 ${shellSingle(py)}`;
  }

  const js = unique.find((file) => ['.js', '.mjs', '.cjs'].includes(extname(file).toLowerCase()));
  if (js && basename(js) !== 'package.json') {
    return `node ${shellSingle(js)}`;
  }

  return undefined;
}

function shellSingle(file: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(file)) return file;
  return `'${file.replace(/'/g, `'\\''`)}'`;
}
