'use strict';

/** 桌宠行为层单元测试：node test/pet.test.js */

const assert = require('assert');
const {
  defaultPetState, sanitizePetState, applyInteraction, decayMood,
  pickMood, pickMessage, clampToWorkArea, snapToEdge,
  countOverdue, countDueSoon, expForLevel, levelForExp,
  FEED_COOLDOWN_MS, PAT_COOLDOWN_MS,
} = require('../src/pet-behavior');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

const NOW = new Date(2026, 9, 29, 12, 0, 0).getTime(); // 本地时间中午
const NIGHT = new Date(2026, 9, 29, 23, 30, 0).getTime();

console.log('pet-behavior 测试:');

ok('defaultPetState: 初始值合法', () => {
  const s = defaultPetState();
  assert.strictEqual(s.mood, 80);
  assert.strictEqual(s.exp, 0);
  assert.strictEqual(s.level, 1);
  assert.strictEqual(s.fedAt, null);
});

ok('expForLevel/levelForExp: 级差递增 100/300/600', () => {
  assert.strictEqual(expForLevel(2), 100);
  assert.strictEqual(expForLevel(3), 300);
  assert.strictEqual(expForLevel(4), 600);
  assert.strictEqual(levelForExp(0).level, 1);
  assert.strictEqual(levelForExp(99).level, 1);
  assert.strictEqual(levelForExp(100).level, 2);
  assert.strictEqual(levelForExp(299).level, 2);
  assert.strictEqual(levelForExp(300).level, 3);
  assert.strictEqual(levelForExp(100).progress, 0);
  assert.ok(levelForExp(200).progress > 0 && levelForExp(200).progress < 1);
});

ok('sanitizePetState: 坏数据回落默认值', () => {
  const s = sanitizePetState(null);
  assert.strictEqual(s.mood, 80);
  assert.strictEqual(s.exp, 0);
  const s2 = sanitizePetState({ mood: 999, exp: -5, fedAt: 'bad', level: 42 });
  assert.strictEqual(s2.mood, 100);
  assert.strictEqual(s2.exp, 0);
  assert.strictEqual(s2.fedAt, null);
  assert.strictEqual(s2.level, 1); // 等级始终由经验推算
});

ok('applyInteraction: 抚摸 +5 心情 +10 经验', () => {
  const { state, accepted, levelUp } = applyInteraction(defaultPetState(), 'pat', NOW);
  assert.strictEqual(accepted, true);
  assert.strictEqual(state.mood, 85);
  assert.strictEqual(state.exp, 10);
  assert.strictEqual(state.lastPatAt, NOW);
  assert.strictEqual(levelUp, false);
});

ok('applyInteraction: 1 分钟内重复抚摸无收益', () => {
  const first = applyInteraction(defaultPetState(), 'pat', NOW);
  const again = applyInteraction(first.state, 'pat', NOW + 30 * 1000);
  assert.strictEqual(again.accepted, false);
  assert.strictEqual(again.reason, 'pat-cooldown');
  assert.strictEqual(again.state.exp, first.state.exp);
  const later = applyInteraction(first.state, 'pat', NOW + PAT_COOLDOWN_MS);
  assert.strictEqual(later.accepted, true);
  assert.strictEqual(later.state.exp, first.state.exp + 10);
});

ok('applyInteraction: 喂食 +20 心情 +15 经验，4 小时冷却', () => {
  const fed = applyInteraction(defaultPetState(), 'feed', NOW);
  assert.strictEqual(fed.accepted, true);
  assert.strictEqual(fed.state.mood, 100); // 80+20 钳制在 100
  assert.strictEqual(fed.state.exp, 15);
  assert.strictEqual(fed.state.fedAt, NOW);
  const again = applyInteraction(fed.state, 'feed', NOW + FEED_COOLDOWN_MS - 1000);
  assert.strictEqual(again.accepted, false);
  assert.strictEqual(again.reason, 'feed-cooldown');
  const later = applyInteraction(fed.state, 'feed', NOW + FEED_COOLDOWN_MS);
  assert.strictEqual(later.accepted, true);
});

ok('applyInteraction: 完成任务 +10 心情 +20 经验并触发升级', () => {
  const base = { ...defaultPetState(), exp: 95, mood: 50 };
  const { state, accepted, levelUp } = applyInteraction(base, 'task-done', NOW);
  assert.strictEqual(accepted, true);
  assert.strictEqual(state.mood, 60);
  assert.strictEqual(state.exp, 115);
  assert.strictEqual(state.level, 2);
  assert.strictEqual(levelUp, true);
});

ok('applyInteraction: 未知动作拒绝', () => {
  const r = applyInteraction(defaultPetState(), 'dance', NOW);
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.reason, 'unknown-action');
});

ok('decayMood: 闲置每整小时 -2 心情，下限 0', () => {
  const base = { ...defaultPetState(), mood: 50, lastDecayAt: NOW };
  const after2h = decayMood(base, NOW + 2 * 60 * 60 * 1000);
  assert.strictEqual(after2h.mood, 46);
  const floor = decayMood({ ...base, mood: 3 }, NOW + 5 * 60 * 60 * 1000);
  assert.strictEqual(floor.mood, 0);
  const none = decayMood(base, NOW + 30 * 60 * 1000); // 不足 1 小时
  assert.strictEqual(none.mood, 50);
});

ok('decayMood: 无基线时不衰减只记录时钟', () => {
  const s = decayMood(defaultPetState(), NOW);
  assert.strictEqual(s.mood, 80);
  assert.strictEqual(s.lastDecayAt, NOW);
});

ok('decayMood: 交互重置衰减时钟', () => {
  const r = applyInteraction({ ...defaultPetState(), lastDecayAt: NOW - 10 * 60 * 60 * 1000 }, 'pat', NOW);
  assert.strictEqual(r.state.lastDecayAt, NOW);
  const after = decayMood(r.state, NOW + 30 * 60 * 1000);
  assert.strictEqual(after.mood, r.state.mood);
});

ok('pickMood: 逾期 > 饥饿 > 睡眠 > 分档', () => {
  assert.strictEqual(pickMood(defaultPetState(), 2, NIGHT), 'sad');
  assert.strictEqual(pickMood({ ...defaultPetState(), mood: 10 }, 0, NIGHT), 'hungry');
  assert.strictEqual(pickMood(defaultPetState(), 0, NIGHT), 'sleeping');
  assert.strictEqual(pickMood(defaultPetState(), 0, NOW), 'happy');
  assert.strictEqual(pickMood({ ...defaultPetState(), mood: 50 }, 0, NOW), 'idle');
  assert.strictEqual(pickMood({ ...defaultPetState(), mood: 10, lastDecayAt: NOW }, 0, NOW), 'hungry');
});

ok('pickMessage: 各事件返回非空文案，未知事件为空串', () => {
  for (const ev of ['created', 'done', 'due', 'overdue', 'idle-chat', 'pat', 'feed', 'feed-cooldown', 'levelup', 'sleep', 'wake']) {
    const msg = pickMessage(ev, () => 0);
    assert.ok(typeof msg === 'string' && msg.length > 0, ev);
  }
  assert.strictEqual(pickMessage('nope', () => 0), '');
  // rand 越界索引钳制到末项
  assert.strictEqual(pickMessage('pat', () => 0.999), pickMessage('pat', () => 1));
});

ok('clampToWorkArea: 越界位置钳回可见区', () => {
  const wa = { x: 100, y: 50, width: 800, height: 600 };
  const size = { width: 200, height: 150 };
  assert.deepStrictEqual(clampToWorkArea({ x: -50, y: -10 }, size, wa), { x: 100, y: 50 });
  assert.deepStrictEqual(clampToWorkArea({ x: 5000, y: 5000 }, size, wa), { x: 700, y: 500 });
  assert.deepStrictEqual(clampToWorkArea({ x: 300, y: 200 }, size, wa), { x: 300, y: 200 });
  // 窗口比工作区大：钉在原点
  assert.deepStrictEqual(clampToWorkArea({ x: 300, y: 300 }, { width: 900, height: 700 }, wa), { x: 100, y: 50 });
});

ok('snapToEdge: 阈值内吸附到最近边', () => {
  const wa = { x: 0, y: 0, width: 1000, height: 800 };
  const size = { width: 200, height: 150 };
  assert.deepStrictEqual(snapToEdge({ x: 8, y: 400 }, size, wa), { x: 0, y: 400, snapped: 'left' });
  assert.deepStrictEqual(snapToEdge({ x: 795, y: 400 }, size, wa), { x: 800, y: 400, snapped: 'right' });
  assert.deepStrictEqual(snapToEdge({ x: 400, y: 5 }, size, wa), { x: 400, y: 0, snapped: 'top' });
  assert.deepStrictEqual(snapToEdge({ x: 400, y: 642 }, size, wa), { x: 400, y: 650, snapped: 'bottom' });
});

ok('snapToEdge: 阈值外不吸附', () => {
  const wa = { x: 0, y: 0, width: 1000, height: 800 };
  const size = { width: 200, height: 150 };
  const r = snapToEdge({ x: 50, y: 300 }, size, wa);
  assert.strictEqual(r.snapped, null);
  assert.deepStrictEqual({ x: r.x, y: r.y }, { x: 50, y: 300 });
});

ok('countOverdue/countDueSoon: 只统计未完成任务', () => {
  const tasks = [
    { id: 'a', dueAt: new Date(NOW - 60 * 1000).toISOString(), status: 'todo' },   // 逾期
    { id: 'b', dueAt: new Date(NOW - 60 * 1000).toISOString(), status: 'done' },   // 已完成不算
    { id: 'c', dueAt: new Date(NOW + 30 * 60 * 1000).toISOString(), status: 'doing' }, // 1 小时内到期
    { id: 'd', dueAt: new Date(NOW + 5 * 60 * 60 * 1000).toISOString(), status: 'todo' }, // 太远
    { id: 'e', dueAt: null, status: 'todo' },
  ];
  assert.strictEqual(countOverdue(tasks, NOW), 1);
  assert.strictEqual(countDueSoon(tasks, NOW), 1);
  assert.strictEqual(countOverdue(null, NOW), 0);
});

console.log(`\npet-behavior: ${passed} 项全部通过`);
