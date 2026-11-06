'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { translate, english } = require('../src/i18n');
const en = (message, ...values) => translate('en', message, ...values);
const zh = (message, ...values) => translate('zh-CN', message, ...values);
assert.equal(en('携手'), 'WithYou');
assert.equal(zh('携手'), '携手');
assert.equal(en`已删除「${'用户原文'}」`, 'Deleted “用户原文”');
assert.equal(zh`子任务 ${1}/${3}`, '子任务 1/3');
assert.equal(en('自定义原文'), '自定义原文');
assert.equal(en`已完成 ${2} / ${5}`, 'Completed 2 / 5');
// Static UI text and accessibility attributes must have translations.
for (const filename of fs.readdirSync(path.join(__dirname, '../src/renderer')).filter(name => name.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer', filename), 'utf8');
  for (const match of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) {
    const key = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    assert.ok(Object.hasOwn(english, key), filename + ': ' + key);
  }
}
console.log('i18n: names, tagged interpolation, user content and static catalog coverage passed.');
