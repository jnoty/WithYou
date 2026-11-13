'use strict';

/** 数据层单元测试：node test/store.test.js */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskStore, dueForReminder, expandOccurrences, MAX_TITLE, MAX_NOTE, MAX_STEP_CONTENT, MAX_BATCH } = require('../src/store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'withyou-test-'));
const file = path.join(dir, 'tasks.json');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

console.log('TaskStore 测试:');

ok('create: 仅标题必填，自动 sortOrder / 时间戳', () => {
  const s = new TaskStore(file);
  const t = s.create({ title: '写周报' });
  assert.strictEqual(t.title, '写周报');
  assert.strictEqual(t.status, 'todo');
  assert.ok(t.id && t.createdAt && t.updatedAt);
  assert.strictEqual(t.completedAt, null);
  assert.ok(t.sortOrder > 0);
});

ok('create: 空标题抛错', () => {
  const s = new TaskStore(file);
  assert.throws(() => s.create({ title: '   ' }));
});

ok('project: 旧任务默认未分类，项目可保存、导入和清空', () => {
  const s = new TaskStore(path.join(dir, 'projects.json'));
  const [legacy] = s.importJSON(JSON.stringify([{ title: '旧任务' }]));
  assert.strictEqual(legacy.project, '');
  const t = s.create({ title: '设计评审', project: '  新项目  ' });
  assert.strictEqual(new TaskStore(s.filePath).get(t.id).project, '新项目');
  assert.strictEqual(s.importJSON(s.exportJSON()).find(task => task.title === t.title).project, '新项目');
  s.update(t.id, { project: '' });
  assert.strictEqual(new TaskStore(s.filePath).get(t.id).project, '');
});

ok('create: 标题/备注超长截断', () => {
  const s = new TaskStore(file);
  const t = s.create({ title: 'x'.repeat(300), note: 'y'.repeat(1500) });
  assert.strictEqual(t.title.length, MAX_TITLE);
  assert.strictEqual(t.note.length, MAX_NOTE);
  assert.strictEqual(MAX_TITLE, 200);
  assert.strictEqual(MAX_NOTE, 1000);
});

ok('steps: 创建 / 更新子任务（空内容丢弃、补 id、状态归一、持久化）', () => {
  const s = new TaskStore(file);
  s.clear();
  const t = s.create({
    title: '带子任务',
    steps: [
      { content: '步骤一', status: 'done' },
      { id: 'keep-id', content: '步骤二', status: 'weird' },
      { content: '   ' },
      { content: 'z'.repeat(300) },
    ],
  });
  assert.strictEqual(t.steps.length, 3);
  assert.strictEqual(t.steps[0].status, 'done');
  assert.ok(t.steps[0].id);
  assert.strictEqual(t.steps[1].id, 'keep-id');
  assert.strictEqual(t.steps[1].status, 'todo');
  assert.strictEqual(t.steps[2].content.length, MAX_STEP_CONTENT);
  s.update(t.id, { steps: [{ content: '只剩一个', status: 'done' }] });
  assert.strictEqual(s.get(t.id).steps.length, 1);
  assert.strictEqual(s.get(t.id).steps[0].status, 'done');
  const s2 = new TaskStore(file);
  assert.strictEqual(s2.get(t.id).steps[0].content, '只剩一个');
});

ok('create: startAt / dueAt（开始 / 结束时间）正确持久化', () => {
  const s = new TaskStore(file);
  s.clear();
  const t = s.create({
    title: '带时间的任务',
    startAt: '2030-01-01T02:00:00.000Z',
    dueAt: '2030-01-01T10:00:00.000Z',
  });
  const s2 = new TaskStore(file);
  const loaded = s2.get(t.id);
  assert.strictEqual(loaded.startAt, '2030-01-01T02:00:00.000Z');
  assert.strictEqual(loaded.dueAt, '2030-01-01T10:00:00.000Z');
});

ok('create: 非法 / 缺省 startAt 归一为 null', () => {
  const s = new TaskStore(file);
  const bad = s.create({ title: '非法时间', startAt: 'not-a-date', dueAt: 'oops' });
  assert.strictEqual(bad.startAt, null);
  assert.strictEqual(bad.dueAt, null);
  const none = s.create({ title: '无时间' });
  assert.strictEqual(none.startAt, null);
});

ok('compat: 旧数据（无 startAt 字段）加载补 null', () => {
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    tasks: [{ id: 'legacy-1', title: '旧任务', status: 'todo', dueAt: '2030-01-01T10:00:00.000Z' }],
  }), 'utf8');
  const s = new TaskStore(file);
  assert.strictEqual(s.get('legacy-1').startAt, null);
  assert.strictEqual(s.get('legacy-1').dueAt, '2030-01-01T10:00:00.000Z');
  assert.equal(Object.hasOwn(s.get('legacy-1'), 'dateAt'), false);
});




ok('update: 修改 startAt 生效且重置 notifiedAt', () => {
  const s = new TaskStore(file);
  const t = s.create({ title: '任务S', startAt: '2030-01-01T02:00:00.000Z', dueAt: '2030-01-01T10:00:00.000Z' });
  t.notifiedAt = new Date().toISOString();
  s.save();
  s.update(t.id, { startAt: '2030-01-02T03:00:00.000Z' });
  assert.strictEqual(s.get(t.id).startAt, '2030-01-02T03:00:00.000Z');
  assert.equal(s.get(t.id).notifiedAt, null);
  s.update(t.id, { startAt: null });
  assert.strictEqual(s.get(t.id).startAt, null);
});

ok('expandOccurrences: 每天展开（保持时刻与时长）', () => {
  const iso = (day, h, mi) => new Date(2030, 0, day, h, mi).toISOString();
  const plan = expandOccurrences({ startAt: iso(1, 15, 0), dueAt: iso(1, 16, 0), freq: 'daily', until: '2030-01-03' });
  assert.strictEqual(plan.length, 3);
  assert.strictEqual(new Date(plan[0].startAt).getTime(), new Date(2030, 0, 1, 15, 0).getTime());
  assert.strictEqual(new Date(plan[1].startAt).getTime(), new Date(2030, 0, 2, 15, 0).getTime());
  assert.strictEqual(new Date(plan[2].startAt).getTime(), new Date(2030, 0, 3, 15, 0).getTime());
  assert.strictEqual(new Date(plan[2].dueAt).getTime(), new Date(2030, 0, 3, 16, 0).getTime());
});

ok('expandOccurrences: 每周展开 / 仅结束时间', () => {
  const plan = expandOccurrences({
    dueAt: new Date(2030, 0, 3, 9, 0).toISOString(),
    freq: 'weekly',
    until: '2030-01-17',
  });
  assert.strictEqual(plan.length, 3);
  assert.strictEqual(plan[0].startAt, null);
  assert.strictEqual(new Date(plan[2].dueAt).getTime(), new Date(2030, 0, 17, 9, 0).getTime());
});

ok('expandOccurrences: 每月展开，月末取整（1/31 → 2/28 → 3/31）', () => {
  const plan = expandOccurrences({
    startAt: new Date(2030, 0, 31, 15, 0).toISOString(),
    freq: 'monthly',
    until: '2030-03-31',
  });
  assert.strictEqual(plan.length, 3);
  assert.strictEqual(new Date(plan[1].startAt).getTime(), new Date(2030, 1, 28, 15, 0).getTime());
  assert.strictEqual(new Date(plan[2].startAt).getTime(), new Date(2030, 2, 31, 15, 0).getTime());
});

ok('expandOccurrences: 参数校验与条数上限', () => {
  const iso = (day) => new Date(2030, 0, day, 15, 0).toISOString();
  assert.throws(() => expandOccurrences({ freq: 'daily', until: '2030-01-01' })); // 无时间锚点
  assert.throws(() => expandOccurrences({ startAt: iso(1), freq: 'yearly', until: '2030-01-01' })); // 坏频率
  assert.throws(() => expandOccurrences({ startAt: iso(1), freq: 'daily' })); // 无截止日期
  assert.throws(() => expandOccurrences({ startAt: iso(1), freq: 'daily', until: '2029-12-31' })); // 截止早于开始
  assert.throws(() => expandOccurrences({ startAt: iso(1), freq: 'daily', until: '2030-12-31' })); // 超上限
  assert.ok(MAX_BATCH > 0);
});

ok('createMany: 批量创建一次落盘（重复任务展开）', () => {
  const s = new TaskStore(file);
  s.clear();
  const plan = expandOccurrences({
    startAt: new Date(2030, 0, 1, 15, 0).toISOString(),
    freq: 'daily',
    until: '2030-01-05',
  });
  const created = s.createMany(plan.map((occ) => ({ title: '每日站会', startAt: occ.startAt })));
  assert.strictEqual(created.length, 5);
  const s2 = new TaskStore(file);
  assert.strictEqual(s2.list().length, 5);
  assert.ok(s2.list().every((t) => t.title === '每日站会' && t.startAt));
  const orders = s2.list().map((t) => t.sortOrder);
  assert.deepStrictEqual(orders, [...orders].sort((x, y) => x - y));
});

ok('persist: 重新加载数据一致（模拟重启）', () => {
  const s = new TaskStore(file);
  s.create({ title: '任务A', note: '备注', color: 'blue', dueAt: '2030-01-01T10:00:00.000Z' });
  const s2 = new TaskStore(file);
  assert.strictEqual(s2.list().length, s.list().length);
  assert.strictEqual(s2.list()[s2.list().length - 1].title, '任务A');
});

ok('persist: 原子落盘无 .tmp 残留', () => {
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(file + '.tmp'));
});

ok('update: 完成/取消完成维护 completedAt', () => {
  const s = new TaskStore(file);
  const t = s.create({ title: '任务B' });
  s.update(t.id, { status: 'done' });
  assert.ok(s.get(t.id).completedAt);
  s.update(t.id, { status: 'todo' });
  assert.strictEqual(s.get(t.id).completedAt, null);
});

ok('update: 取消状态维护 cancelledAt / cancelReason', () => {
  const s = new TaskStore(file);
  const t = s.create({ title: '任务Cancel' });
  s.update(t.id, { status: 'cancelled', cancelReason: '需求变更' });
  assert.ok(s.get(t.id).cancelledAt);
  assert.strictEqual(s.get(t.id).cancelReason, '需求变更');
  s.update(t.id, { status: 'todo' });
  assert.strictEqual(s.get(t.id).cancelledAt, null);
});

ok('update: 修改 dueAt 重置 notifiedAt', () => {
  const s = new TaskStore(file);
  const t = s.create({ title: '任务C', dueAt: '2030-01-01T10:00:00.000Z' });
  t.notifiedAt = new Date().toISOString();
  s.save();
  s.update(t.id, { dueAt: '2030-02-01T10:00:00.000Z' });
  assert.strictEqual(s.get(t.id).notifiedAt, null);
});

ok('remove + restore: 撤销恢复原数据', () => {
  const s = new TaskStore(file);
  const t = s.create({ title: '任务D', note: '保留' });
  const idx = s.list().findIndex((x) => x.id === t.id);
  s.remove(t.id);
  assert.strictEqual(s.get(t.id), null);
  s.restore(t, idx);
  assert.strictEqual(s.get(t.id).note, '保留');
});

ok('reorder: 列内排序持久化', () => {
  const s = new TaskStore(file);
  s.clear();
  const a = s.create({ title: 'a' });
  const b = s.create({ title: 'b' });
  const c = s.create({ title: 'c' });
  s.reorder('todo', [c.id, a.id, b.id]);
  const s2 = new TaskStore(file);
  const order = s2.list().sort((x, y) => x.sortOrder - y.sortOrder).map((t) => t.title);
  assert.deepStrictEqual(order, ['c', 'a', 'b']);
});

ok('export + import: 完整恢复', () => {
  const s = new TaskStore(file);
  s.clear();
  s.create({ title: '导出1', color: 'red', startAt: '2030-02-28T01:00:00.000Z', dueAt: '2030-03-01T08:00:00.000Z' });
  s.create({ title: '导出2', status: 'doing' });
  const json = s.exportJSON();
  s.clear();
  assert.strictEqual(s.list().length, 0);
  const imported = s.importJSON(json);
  assert.strictEqual(imported.length, 2);
  assert.strictEqual(s.list()[0].title, '导出1');
  assert.strictEqual(s.list()[0].color, 'red');
  assert.strictEqual(s.list()[0].startAt, '2030-02-28T01:00:00.000Z');
});

ok('import: 非法 JSON 抛错', () => {
  const s = new TaskStore(file);
  assert.throws(() => s.importJSON('not-json'));
  assert.throws(() => s.importJSON('{"foo": 1}'));
});

ok('import: 旧版 v3 备份格式映射（content / metadata / scheduled*）', () => {
  const s = new TaskStore(file);
  s.clear();
  const v3 = {
    version: '3.0.0',
    exportDate: '2026-10-29T11:42:03.575Z',
    tasks: [
      {
        id: 'mvt7y2kvf1sq80nadmr',
        content: 'WikiReview 校验规则调整',
        status: 'todo',
        completed: false,
        createdAt: '2026-10-29T07:25:28.591Z',
        updatedAt: '2026-10-29T07:25:28.591Z',
        startedAt: null,
        completedAt: null,
        totalDuration: 0,
        listId: 0,
        metadata: {
          note: '备注内容',
          steps: [
            { id: '1', content: '定位校验逻辑', status: 'done' },
            { id: '2', content: '调整校验规则', status: 'todo' },
          ],
        },
        recurrence: null,
        scheduledStartAt: '2030-10-29T16:00:00.000Z',
        scheduledEndAt: '2030-10-29T17:00:00.000Z',
        dueDate: null,
        dueTime: null,
      },
      {
        id: 'mvqimqp9hrckkbla0ui',
        content: '已完成任务',
        status: 'done',
        completed: true,
        createdAt: '2026-10-27T10:01:17.229Z',
        updatedAt: '2026-10-28T09:05:49.099Z',
        completedAt: '2026-10-28T09:05:49.099Z',
        metadata: {},
        scheduledStartAt: null,
        scheduledEndAt: null,
        dueDate: '2030-11-30',
        dueTime: '16:30',
      },
      {
        id: 'overdue-old',
        content: '历史逾期任务',
        status: 'todo',
        completed: false,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        metadata: {},
        scheduledStartAt: null,
        scheduledEndAt: '2020-01-02T00:00:00.000Z',
      },
    ],
    lists: [{ id: 0, name: '默认清单' }],
    config: { theme: 'system' },
    tools: { tables: {} },
  };
  const imported = s.importJSON(JSON.stringify(v3));
  assert.strictEqual(imported.length, 3);

  const a = s.get('mvt7y2kvf1sq80nadmr');
  assert.strictEqual(a.title, 'WikiReview 校验规则调整');
  assert.strictEqual(a.note, '备注内容');
  assert.strictEqual(a.status, 'todo');
  assert.strictEqual(a.startAt, '2030-10-29T16:00:00.000Z');
  assert.strictEqual(a.dueAt, '2030-10-29T17:00:00.000Z');
  assert.strictEqual(a.createdAt, '2026-10-29T07:25:28.591Z');
  assert.strictEqual(a.steps.length, 2);
  assert.strictEqual(a.steps[0].status, 'done');
  assert.strictEqual(a.steps[1].status, 'todo');
  assert.strictEqual(a.notifiedAt, null); // 未到期，不预标记提醒

  const b = s.get('mvqimqp9hrckkbla0ui');
  assert.strictEqual(b.status, 'done');
  assert.strictEqual(b.completedAt, '2026-10-28T09:05:49.099Z');
  // dueDate + dueTime 兜底合成 dueAt（本地时刻 16:30）
  assert.strictEqual(new Date(b.dueAt).getTime(), new Date(2030, 10, 30, 16, 30).getTime());

  // 历史到期未完成任务标记为已提醒，避免导入瞬间集中弹通知
  assert.ok(s.get('overdue-old').notifiedAt);
});

ok('import: 合并追加（保留现有任务，id 冲突重新生成）', () => {
  const s = new TaskStore(file);
  s.clear();
  s.create({ title: '已有任务' });
  s.importJSON(JSON.stringify({ tasks: [{ id: 'dup', title: '第一次导入' }] }));
  const before = s.list().length;
  const imported = s.importJSON(JSON.stringify({
    tasks: [
      { id: 'dup', title: '第二次导入' },
      { title: '新任务' },
    ],
  }));
  assert.strictEqual(imported.length, 2);
  assert.strictEqual(s.list().length, before + 2);
  assert.ok(s.list().some((t) => t.title === '已有任务'));
  assert.ok(s.list().some((t) => t.title === '第一次导入'));
  const dup = imported.find((t) => t.title === '第二次导入');
  assert.notStrictEqual(dup.id, 'dup');
  assert.ok(s.get(dup.id));
});

ok('corrupt file: 损坏数据文件不致崩溃', () => {
  fs.writeFileSync(file, '{{{ broken', 'utf8');
  const s = new TaskStore(file);
  assert.deepStrictEqual(s.list(), []);
});

ok('updateSeries: 仅此 / 后续 / 整个系列', () => {
  const s = new TaskStore(path.join(dir, 'series.json'));
  const seriesId = 'series-1';
  const created = s.createMany([1, 2, 3].map(day => ({
    title: '每日站会', seriesId, startAt: new Date(2030, 0, day, 9, 0).toISOString(),
  })));
  s.updateSeries(created[1].id, { title: '只改第二条' }, 'one');
  assert.equal(s.get(created[0].id).title, '每日站会');
  assert.equal(s.get(created[1].id).title, '只改第二条');
  assert.equal(s.get(created[2].id).title, '每日站会');
  s.updateSeries(created[1].id, { title: '后续会议' }, 'future');
  assert.equal(s.get(created[0].id).title, '每日站会');
  assert.equal(s.get(created[1].id).title, '后续会议');
  assert.equal(s.get(created[2].id).title, '后续会议');
  s.updateSeries(created[1].id, { title: '全部会议' }, 'all');
  assert.deepEqual(s.list().map(t => t.title), ['全部会议', '全部会议', '全部会议']);
});


ok('legacy date-only data: 保留备注，不补时间或提醒', () => {
  const target = path.join(dir, 'legacy-date.json');
  fs.writeFileSync(target, JSON.stringify({tasks:[{id:'old',title:'旧日期任务',note:'原备注',dateAt:'2030-05-01'}]}));
  const s = new TaskStore(target); const task = s.get('old');
  assert.match(task.note, /原日期：2030-05-01/); assert.match(task.note, /原备注/);
  assert.equal(Object.hasOwn(task,'dateAt'),false);
  assert.equal(task.startAt,null); assert.equal(task.dueAt,null);
  assert.equal(dueForReminder(s.list(),Date.parse('2031-01-01')).length,0);
  s.save(); assert.equal(new TaskStore(target).get('old').note,task.note);
  assert.throws(() => expandOccurrences({dateAt:'2030-05-01',freq:'daily',until:'2030-05-03'}), /开始时间或截止时间/);
});

ok('dueForReminder: 到期未提醒且未完成的任务', () => {
  const now = Date.now();
  const mk = (over) => ({
    id: 'x', title: 't', status: 'todo', completedAt: null,
    dueAt: new Date(now - 1000).toISOString(), notifiedAt: null, ...over,
  });
  assert.strictEqual(dueForReminder([mk({})], now).length, 1);
  assert.strictEqual(dueForReminder([mk({ notifiedAt: new Date().toISOString() })], now).length, 0);
  assert.strictEqual(dueForReminder([mk({ status: 'done' })], now).length, 0);
  assert.strictEqual(dueForReminder([mk({ status: 'cancelled' })], now).length, 0);
  assert.strictEqual(dueForReminder([mk({ dueAt: new Date(now + 6 * 60000).toISOString() })], now).length, 0);
  // 只有开始时间的会议/事件按开始时间提醒。
  assert.strictEqual(dueForReminder([mk({ dueAt: null, startAt: new Date(now - 1000).toISOString() })], now).length, 1);
  assert.strictEqual(dueForReminder([mk({ dueAt: null, startAt: new Date(now + 6 * 60000).toISOString() })], now).length, 0);
  // 缺少提前量的旧任务也默认在开始前五分钟提醒。
  assert.strictEqual(dueForReminder([mk({ startAt: new Date(now + 5 * 60000).toISOString(), dueAt: new Date(now + 60 * 60000).toISOString() })], now).length, 1);
  // 兼容旧的独立提醒时间。
  assert.strictEqual(dueForReminder([mk({ reminderAt: new Date(now - 1000).toISOString(), dueAt: new Date(now + 60000).toISOString() })], now).length, 1);
  assert.strictEqual(dueForReminder([mk({ reminderAt: new Date(now + 60000).toISOString(), dueAt: new Date(now - 60000).toISOString() })], now).length, 0);
  assert.strictEqual(dueForReminder([mk({ reminderDisabled: true })], now).length, 0);
  assert.equal(dueForReminder([mk({ dueAt: null, startAt: null, dateAt: '2000-01-01' })], now).length, 0);

});

ok('reminderMinutes: 三档提前提醒，改期后重新计算', () => {
  const s = new TaskStore(path.join(dir, 'reminder-offsets.json'));
  for (const minutes of [5,10,30]) {
    const task = s.create({ title:'提醒', startAt:'2030-01-01T10:00:00Z', dueAt:'2030-01-01T12:00:00Z', reminderMinutes:minutes });
    const reminder = Date.parse(task.startAt) - minutes * 60000;
    assert.equal(dueForReminder([task],reminder-1).length,0);
    assert.equal(dueForReminder([task],reminder).length,1);
  }
  const task = s.create({title:'只有开始时间',startAt:'2030-01-01T10:00:00Z',reminderMinutes:10});
  assert.equal(dueForReminder([task], Date.parse('2030-01-01T09:50:00Z')).length,1);
  task.notifiedAt = '2030-01-01T09:50:00Z';
  s.update(task.id,{startAt:'2030-01-02T10:00:00Z'});
  assert.equal(task.notifiedAt,null);
  assert.equal(dueForReminder([task], Date.parse('2030-01-02T09:49:00Z')).length,0);
  assert.equal(dueForReminder([task], Date.parse('2030-01-02T09:50:00Z')).length,1);
  assert.equal(new TaskStore(s.filePath).get(task.id).reminderMinutes,10);
  assert.equal(dueForReminder([s.create({title:'无时间',reminderMinutes:5})], Date.now()).length,0);
  const deadline = s.create({ title: '只有截止时间', dueAt: '2030-01-01T12:00:00Z' });
  const fallbackTime = Date.parse('2030-01-01T11:55:00Z');
  assert.equal(dueForReminder([deadline], fallbackTime - 1).length, 0);
  assert.equal(dueForReminder([deadline], fallbackTime).length, 1);
});

ok('reminderMinutes: 只修改结束时间时保留已提醒标记', () => {
  const s = new TaskStore(path.join(dir, 'reminder-dedup.json'));
  const task = s.create({ title: '会议', startAt: '2030-01-01T10:00:00Z', dueAt: '2030-01-01T12:00:00Z' });
  const notifiedAt = '2030-01-01T09:55:00Z';
  task.notifiedAt = notifiedAt;
  s.update(task.id, { dueAt: '2030-01-01T13:00:00Z', reminderMinutes: 5, reminderAt: null, reminderDisabled: false });
  assert.equal(task.notifiedAt, notifiedAt);
  assert.equal(dueForReminder([task], Date.parse(notifiedAt)).length, 0);
});

console.log(`\n全部 ${passed} 项测试通过 ✓`);
