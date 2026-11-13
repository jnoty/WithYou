'use strict';

const fs = require('fs');
const { atomicWriteJSON } = require('./store');

const id = () => require('crypto').randomUUID();
const text = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const samePlace = (a, b) => `${a.project}\u0000${a.location}`.trim().toLowerCase() ===
  `${b.project}\u0000${b.location}`.trim().toLowerCase();

class ProjectResourceStore {
  constructor(filePath) { this.filePath = filePath; this.items = []; this.loadFailed = false; this.load(); }
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      // 文件不存在是正常首次启动；其他读取失败保留原文件，避免被空列表覆盖。
      if (err && err.code !== 'ENOENT') {
        this.loadFailed = true;
        console.error('读取项目资料失败:', err.message);
      }
      this.items = [];
      return this.items;
    }
    try {
      const data = JSON.parse(raw);
      this.items = Array.isArray(data.items) ? data.items.map(x => this.sanitize(x)).filter(Boolean) : [];
    } catch (err) {
      // JSON 损坏时先隔离原文件，下一次保存不会把用户资料覆盖成空。
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}.json`);
      } catch (_) { /* 隔离失败时仍以空列表启动，但不主动写盘 */ }
      console.error('项目资料文件损坏，已隔离:', err.message);
      this.items = [];
    }
    return this.items;
  }
  sanitize(x) {
    if (!x || typeof x !== 'object') return null;
    const project = text(x.project, 100), name = text(x.name, 150);
    const location = text(x.location, 2000).split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean).join('\n');
    if (!project || !name || !location) return null;
    const createdAt = typeof x.createdAt === 'string' && x.createdAt ? x.createdAt : new Date().toISOString();
    return { id: typeof x.id === 'string' && x.id ? x.id : id(), project, name, location,
      note: text(x.note, 500), createdAt,
      updatedAt: typeof x.updatedAt === 'string' && x.updatedAt ? x.updatedAt : createdAt };
  }
  importItems(items) {
    const counts = { imported: 0, duplicates: 0, invalid: 0 };
    const before = this.items.slice();
    for (const input of items) {
      const item = this.sanitize(input && typeof input === 'object' ? { ...input, id: undefined } : null);
      if (!item) { counts.invalid++; continue; }
      if (this.items.some(x => samePlace(x, item))) { counts.duplicates++; continue; }
      this.items.push(item); counts.imported++;
    }
    try { if (counts.imported) this.save(); }
    catch (error) { this.items = before; throw error; }
    return counts;
  }
  save() {
    if (this.loadFailed) throw new Error('项目资料文件读取失败，请检查文件权限后重启应用');
    atomicWriteJSON(this.filePath, { version: 1, items: this.items });
    return this.items;
  }
  list() { return this.items; }
  upsert(input = {}) {
    const now = new Date().toISOString();
    const index = input.id ? this.items.findIndex(x => x.id === input.id) : -1;
    const previous = index >= 0 ? this.items[index] : null;
    // 编辑时保留创建时间；新增时允许导入记录自带 createdAt。
    const item = this.sanitize({ ...input, createdAt: previous ? previous.createdAt : input.createdAt, updatedAt: now });
    if (!item) throw new Error('项目、名称和路径不能为空');
    const duplicate = this.items.find(x => x.id !== item.id && samePlace(x, item));
    if (duplicate) throw new Error('同一项目下已存在相同的路径或链接');
    const before = this.items.slice();
    if (index >= 0) this.items[index] = item; else this.items.push(item);
    try { this.save(); } catch (err) { this.items = before; throw err; }
    return item;
  }
  delete(itemId) {
    const before = this.items;
    const next = before.filter(x => x.id !== itemId);
    if (next.length === before.length) return false;
    this.items = next;
    try { this.save(); } catch (err) { this.items = before; throw err; }
    return true;
  }
}

module.exports = { ProjectResourceStore };
