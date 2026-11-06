'use strict';

/**
 * 生成单文件版使用说明：
 *   node tools/build-docs.mjs
 * 将 docs/使用说明.template.html 中的 images/*.png 内联为 base64，
 * 输出 docs/WithYou使用说明.html（可单文件分发、无需附带图片）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'docs');
const templatePath = path.join(docsDir, '使用说明.template.html');
const outPath = path.join(docsDir, 'WithYou使用说明.html');

const html = fs.readFileSync(templatePath, 'utf8');
const inlined = html.replace(/src="images\/([^"]+)"/g, (match, file) => {
  const p = path.join(docsDir, 'images', file);
  if (!fs.existsSync(p)) throw new Error('缺少图片: ' + p);
  return `src="data:image/png;base64,${fs.readFileSync(p).toString('base64')}"`;
});

fs.writeFileSync(outPath, inlined, 'utf8');
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log('已生成:', outPath, `(${kb(fs.statSync(outPath).size)})`);
