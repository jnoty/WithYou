'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectResourceStore } = require('../src/project-resources');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'withyou-resources-'));
const file = path.join(dir, 'project-resources.json');
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

ok('create: 保存项目、名称、位置、备注并落盘', () => {
  const store = new ProjectResourceStore(file);
  const item = store.upsert({ project: '  携手  ', name: ' 设计稿 ', location: ' C:\\work\\design ', note: '  第一版 ' });
  assert.equal(item.project, '携手');
  assert.equal(item.name, '设计稿');
  assert.equal(item.location, 'C:\\work\\design');
  assert.equal(item.note, '第一版');
  assert.ok(item.id && item.createdAt && item.updatedAt);
  const loaded = new ProjectResourceStore(file);
  assert.equal(loaded.list().length, 1);
  assert.equal(loaded.list()[0].location, 'C:\\work\\design');
});

ok('update: 保留 createdAt，只更新 updatedAt', () => {
  const store = new ProjectResourceStore(file);
  const item = store.list()[0];
  const created = item.createdAt;
  const updated = store.upsert({ id: item.id, project: item.project, name: '设计稿 v2', location: item.location, note: '改过' });
  assert.equal(updated.createdAt, created);
  assert.equal(updated.name, '设计稿 v2');
  assert.ok(updated.updatedAt >= created);
});

ok('duplicate: 同项目下相同位置拒绝重复', () => {
  const store = new ProjectResourceStore(file);
  assert.throws(() => store.upsert({ project: '携手', name: '另一个名字', location: 'c:\\WORK\\DESIGN' }), /已存在相同的路径/);
  assert.equal(store.list().length, 1);
});

ok('delete: 删除并持久化', () => {
  const store = new ProjectResourceStore(file);
  const item = store.list()[0];
  assert.equal(store.delete(item.id), true);
  assert.equal(store.list().length, 0);
  assert.equal(new ProjectResourceStore(file).list().length, 0);
});

ok('save 失败时回滚内存，不产生半条记录', () => {
  const store = new ProjectResourceStore(file);
  const original = store.save;
  store.save = () => { throw new Error('disk full'); };
  assert.throws(() => store.upsert({ project: 'P', name: 'N', location: 'C:\\x' }), /disk full/);
  assert.equal(store.list().length, 0);
  store.save = original;
});

ok('delete 失败时恢复原记录', () => {
  const store = new ProjectResourceStore(file);
  const item = store.upsert({ project: 'P', name: 'N', location: 'C:\\x' });
  const original = store.save;
  store.save = () => { throw new Error('disk full'); };
  assert.throws(() => store.delete(item.id), /disk full/);
  assert.equal(store.list().length, 1);
  store.save = original;
});

ok('corrupt: 损坏文件被隔离，不会静默覆盖', () => {
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{{{ not json', 'utf8');
  const store = new ProjectResourceStore(broken);
  assert.deepEqual(store.list(), []);
  const quarantined = fs.readdirSync(dir).filter(name => name.startsWith('broken.json.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.existsSync(broken), false);
});

ok('limits: 超长字段截断，空必填项拒绝', () => {
  const store = new ProjectResourceStore(path.join(dir, 'limits.json'));
  const item = store.upsert({ project: 'p'.repeat(150), name: 'n'.repeat(200), location: 'l'.repeat(2100), note: 'x'.repeat(600) });
  assert.equal(item.project.length, 100);
  assert.equal(item.name.length, 150);
  assert.equal(item.location.length, 2000);
  assert.equal(item.note.length, 500);
  assert.throws(() => store.upsert({ project: 'P', name: '', location: 'C:\\x' }), /不能为空/);
});

ok('importItems: 重复和无效分别计数，磁盘失败整批回滚', () => {
  const store = new ProjectResourceStore(path.join(dir, 'import.json'));
  const item = { project: '项目', name: '文档', location: 'C:/docs' };
  assert.deepEqual(store.importItems([item,item,{}]), { imported: 1, duplicates: 1, invalid: 1 });
  const before = JSON.stringify(store.list());
  store.save = () => { throw new Error('disk full'); };
  assert.throws(() => store.importItems([{...item,location:'C:/other'}]), /disk full/);
  assert.equal(JSON.stringify(store.list()), before);
});

console.log(`\n项目资料 ${passed} 项测试通过 ✓`);
