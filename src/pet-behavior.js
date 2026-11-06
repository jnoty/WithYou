'use strict';

/**
 * 桌宠行为纯逻辑层（不依赖 Electron，可单测）
 * - 心情 / 经验 / 等级 / 喂食冷却 状态机
 * - 心情判定与气泡文案选择
 * - 贴边吸附与位置钳制
 */

const MAX_MOOD = 100;

const PAT_MOOD = 5;
const PAT_EXP = 10;
const PAT_COOLDOWN_MS = 60 * 1000;        // 抚摸 1 分钟内重复无收益

const FEED_MOOD = 20;
const FEED_EXP = 15;
const FEED_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 喂食冷却 4 小时

const DONE_MOOD = 10;
const DONE_EXP = 20;

const MOOD_DECAY_PER_HOUR = 2;            // 闲置每小时 -2 心情
const HOUR_MS = 60 * 60 * 1000;

const LEVEL_STEP_EXP = 100;               // 级差递增：100/200/300…
const EDGE_SNAP_THRESHOLD = 12;

const MESSAGES = {
  created: ['收到！记下来了～', '又一件小事被抓住啦', '记好了，交给我盯着'],
  done: ['完成得漂亮！', '太棒了，叉掉一个！', '干得不错，休息一下？', '效率拉满！'],
  due: ['这条任务快到期啦，去看看？', '时间到咯，别忘了这条任务～', '滴！有任务到期了'],
  overdue: ['有任务逾期啦，快去处理', '这条任务已经过期咯', '逾期的任务在等你…'],
  'idle-chat': ['今天也要加油鸭', '记得喝水、活动一下肩膀', '有我在，任务丢不了', '忙归忙，也别忘了休息', '要不要先做最简单的那条？'],
  pat: ['嘿嘿，好舒服～', '再摸摸头嘛', '喵～', '被摸头了好开心'],
  feed: ['啊呜，真好吃！', '吃饱啦，元气满满！', '谢谢款待～'],
  'feed-cooldown': ['刚吃饱，吃不下啦～', '肚子还饱着呢，等会儿再吃'],
  levelup: ['升级啦！我变强了！', '耶！又成长了一点！'],
  sleep: ['Zzz…', '睡着了…晚安'],
  wake: ['唔…醒来了', '来啦来啦'],
};

/** 默认桌宠状态（时间戳为 epoch 毫秒，null 表示从未发生）。 */
function defaultPetState() {
  return {
    mood: 80,
    exp: 0,
    level: 1,
    fedAt: null,
    lastInteractAt: null,
    lastPatAt: null,
    lastDecayAt: null,
  };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampMood(value) {
  return Math.round(clampNumber(value, 0, MAX_MOOD, 0));
}

function normalizeTime(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 达到 level 所需的累计经验：level 2 → 100，level 3 → 300，level 4 → 600 … */
function expForLevel(level) {
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  return (LEVEL_STEP_EXP * (lv - 1) * lv) / 2;
}

/** 由累计经验推算等级与进度。 */
function levelForExp(exp) {
  const total = Math.max(0, Math.floor(Number(exp) || 0));
  let level = 1;
  while (expForLevel(level + 1) <= total) level += 1;
  const cur = expForLevel(level);
  const next = expForLevel(level + 1);
  const progress = next > cur ? (total - cur) / (next - cur) : 0;
  return { level, progress: Math.min(1, Math.max(0, progress)) };
}

/** 容错解析持久化数据（坏数据回落默认值，等级始终由经验推算）。 */
function sanitizePetState(raw) {
  const d = defaultPetState();
  if (!raw || typeof raw !== 'object') return d;
  const exp = Math.max(0, Math.floor(clampNumber(raw.exp, 0, Number.MAX_SAFE_INTEGER, 0)));
  return {
    mood: clampMood(raw.mood == null ? d.mood : raw.mood),
    exp,
    level: levelForExp(exp).level,
    fedAt: normalizeTime(raw.fedAt),
    lastInteractAt: normalizeTime(raw.lastInteractAt),
    lastPatAt: normalizeTime(raw.lastPatAt),
    lastDecayAt: normalizeTime(raw.lastDecayAt),
  };
}

/**
 * 一次互动的状态转移。
 * @param {object} state 现状态
 * @param {'pat'|'feed'|'task-done'} action
 * @param {number} now
 * @returns {{state: object, accepted: boolean, reason: string|null, levelUp: boolean}}
 */
function applyInteraction(state, action, now = Date.now()) {
  const s = sanitizePetState(state);
  const before = levelForExp(s.exp).level;
  let accepted = true;
  let reason = null;

  if (action === 'pat') {
    if (s.lastPatAt && now - s.lastPatAt < PAT_COOLDOWN_MS) {
      accepted = false;
      reason = 'pat-cooldown';
    } else {
      s.lastPatAt = now;
      s.mood = clampMood(s.mood + PAT_MOOD);
      s.exp += PAT_EXP;
    }
  } else if (action === 'feed') {
    if (s.fedAt && now - s.fedAt < FEED_COOLDOWN_MS) {
      accepted = false;
      reason = 'feed-cooldown';
    } else {
      s.fedAt = now;
      s.mood = clampMood(s.mood + FEED_MOOD);
      s.exp += FEED_EXP;
    }
  } else if (action === 'task-done') {
    s.mood = clampMood(s.mood + DONE_MOOD);
    s.exp += DONE_EXP;
  } else {
    accepted = false;
    reason = 'unknown-action';
  }

  if (accepted) {
    s.lastInteractAt = now;
    s.lastDecayAt = now;
    s.level = levelForExp(s.exp).level;
  }
  const levelUp = accepted && s.level > before;
  return { state: s, accepted, reason, levelUp };
}

/**
 * 闲置衰减：距上次交互（或上次衰减）每整小时 -2 心情，下限 0。
 * 交互会重置衰减时钟（applyInteraction 内已同步 lastDecayAt）。
 */
function decayMood(state, now = Date.now()) {
  const s = sanitizePetState(state);
  const baseline = s.lastDecayAt || s.lastInteractAt;
  if (!baseline) {
    s.lastDecayAt = now;
    return s;
  }
  const hours = Math.floor(Math.max(0, now - baseline) / HOUR_MS);
  if (hours > 0) {
    s.mood = clampMood(s.mood - hours * MOOD_DECAY_PER_HOUR);
  }
  s.lastDecayAt = now;
  return s;
}

/** 心情判定：逾期 > 饥饿 > 睡眠时段 > 心情分档。 */
function pickMood(state, overdueCount = 0, now = Date.now()) {
  const s = sanitizePetState(state);
  if (overdueCount > 0) return 'sad';
  if (s.mood < 30) return 'hungry';
  const hour = new Date(now).getHours();
  if (hour >= 23 || hour < 7) return 'sleeping';
  if (s.mood >= 70) return 'happy';
  return 'idle';
}

/** 选择气泡文案；rand 注入便于确定性测试。 */
function pickMessage(event, rand = Math.random) {
  const list = MESSAGES[event];
  if (!list || !list.length) return '';
  const i = Math.min(list.length - 1, Math.floor(rand() * list.length));
  return list[i];
}

/** 把位置钳回工作区可见范围（多显示器恢复时使用）。 */
function clampToWorkArea(pos, size, workArea) {
  const maxX = workArea.x + Math.max(0, workArea.width - size.width);
  const maxY = workArea.y + Math.max(0, workArea.height - size.height);
  return {
    x: Math.round(Math.min(maxX, Math.max(workArea.x, Number(pos.x) || 0))),
    y: Math.round(Math.min(maxY, Math.max(workArea.y, Number(pos.y) || 0))),
  };
}

/**
 * 贴边吸附：拖动结束时距工作区某一边 ≤ threshold 则贴住该边。
 * @returns {{x:number, y:number, snapped:'left'|'right'|'top'|'bottom'|null}}
 */
function snapToEdge(pos, size, workArea, threshold = EDGE_SNAP_THRESHOLD) {
  const clamped = clampToWorkArea(pos, size, workArea);
  const edges = [
    { id: 'left', dist: clamped.x - workArea.x },
    { id: 'right', dist: (workArea.x + workArea.width) - (clamped.x + size.width) },
    { id: 'top', dist: clamped.y - workArea.y },
    { id: 'bottom', dist: (workArea.y + workArea.height) - (clamped.y + size.height) },
  ].sort((a, b) => a.dist - b.dist);
  const nearest = edges[0];
  if (!nearest || nearest.dist > threshold) return { ...clamped, snapped: null };
  const out = { ...clamped, snapped: nearest.id };
  if (nearest.id === 'left') out.x = workArea.x;
  if (nearest.id === 'right') out.x = workArea.x + workArea.width - size.width;
  if (nearest.id === 'top') out.y = workArea.y;
  if (nearest.id === 'bottom') out.y = workArea.y + workArea.height - size.height;
  out.x = Math.round(out.x);
  out.y = Math.round(out.y);
  return out;
}

/** 逾期任务计数（dueAt 已过且未完成）。 */
function countOverdue(tasks, now = Date.now()) {
  return (Array.isArray(tasks) ? tasks : []).filter((t) => {
    if (!t || !t.dueAt || t.status === 'done' || t.status === 'cancelled' || t.completedAt) return false;
    return new Date(t.dueAt).getTime() < now;
  }).length;
}

/** 即将到期任务计数（dueAt 在 withinMs 内）。 */
function countDueSoon(tasks, now = Date.now(), withinMs = HOUR_MS) {
  return (Array.isArray(tasks) ? tasks : []).filter((t) => {
    if (!t || !t.dueAt || t.status === 'done' || t.status === 'cancelled' || t.completedAt) return false;
    const due = new Date(t.dueAt).getTime();
    return due >= now && due - now <= withinMs;
  }).length;
}

module.exports = {
  defaultPetState,
  sanitizePetState,
  applyInteraction,
  decayMood,
  pickMood,
  pickMessage,
  clampToWorkArea,
  snapToEdge,
  countOverdue,
  countDueSoon,
  expForLevel,
  levelForExp,
  MAX_MOOD,
  FEED_COOLDOWN_MS,
  PAT_COOLDOWN_MS,
  MOOD_DECAY_PER_HOUR,
  EDGE_SNAP_THRESHOLD,
};
