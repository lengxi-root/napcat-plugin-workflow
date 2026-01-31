// 工作流数据存储模块
import fs from 'fs';
import path from 'path';
import type { Workflow } from '../types';
import { pluginState } from '../core/state';

// 缓存
let workflowCache: Workflow[] | null = null;
let userDataCache: Record<string, Record<string, unknown>> | null = null;
let globalDataCache: Record<string, unknown> | null = null;
let watcher: fs.FSWatcher | null = null;

// 工具函数
const filePath = (name: string) => path.join(pluginState.dataPath, name);
const ensureDir = (p: string) => { const d = path.dirname(p); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };
const readJson = <T>(p: string, def: T): T => { try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {} return def; };
const writeJson = (p: string, data: unknown): boolean => { try { ensureDir(p); fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8'); return true; } catch { return false; } };
const fixNum = (n: number) => Number.isInteger(n) ? n : parseFloat(n.toFixed(2));

// ==================== 工作流存储 ====================

export function startWorkflowWatcher(): void {
  if (watcher) return;
  const p = filePath('workflows.json');
  ensureDir(p);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]', 'utf-8');
  try { watcher = fs.watch(p, (e) => { if (e === 'change') { workflowCache = null; pluginState.log('debug', '工作流配置已更新'); } }); }
  catch { pluginState.log('debug', '文件监听启动失败'); }
}

export function stopWorkflowWatcher(): void { if (watcher) { watcher.close(); watcher = null; } }

export function loadWorkflows(): Workflow[] {
  if (workflowCache) return workflowCache;
  workflowCache = readJson(filePath('workflows.json'), []);
  return workflowCache || [];
}

export function saveWorkflows(wfs: Workflow[]): boolean {
  if (!writeJson(filePath('workflows.json'), wfs)) { pluginState.log('error', '保存工作流失败'); return false; }
  workflowCache = wfs;
  return true;
}

export function getWorkflowById(id: string): Workflow | undefined { return loadWorkflows().find(w => w.id === id); }
export function deleteWorkflow(id: string): boolean { return saveWorkflows(loadWorkflows().filter(w => w.id !== id)); }
export function toggleWorkflow(id: string): boolean {
  const wfs = loadWorkflows(), wf = wfs.find(w => w.id === id);
  if (wf) { wf.enabled = !wf.enabled; return saveWorkflows(wfs); }
  return false;
}

// ==================== 用户数据存储 ====================

const loadUser = (): Record<string, Record<string, unknown>> => { if (userDataCache) return userDataCache; return userDataCache = readJson(filePath('user_data.json'), {}); };
const saveUser = (): boolean => writeJson(filePath('user_data.json'), userDataCache || {});

export function getUserValue(uid: string, key: string, def: unknown = null): unknown { return loadUser()[uid]?.[key] ?? def; }

export function setUserValue(uid: string, key: string, val: unknown): boolean {
  const d = loadUser();
  if (!d[uid]) d[uid] = {};
  d[uid][key] = val;
  userDataCache = d;
  return saveUser();
}

export function incrUserValue(uid: string, key: string, amt: number = 1, def: number = 0): number {
  const d = loadUser();
  if (!d[uid]) d[uid] = {};
  const v = fixNum(Number(d[uid][key] ?? def) + amt);
  d[uid][key] = v;
  userDataCache = d;
  saveUser();
  return v;
}

export function deleteUserValue(uid: string, key: string): boolean {
  const d = loadUser();
  if (d[uid] && key in d[uid]) { delete d[uid][key]; userDataCache = d; return saveUser(); }
  return false;
}

// ==================== 全局数据存储 ====================

const loadGlobal = (): Record<string, unknown> => { if (globalDataCache) return globalDataCache; return globalDataCache = readJson(filePath('global_data.json'), {}); };
const saveGlobal = (): boolean => writeJson(filePath('global_data.json'), globalDataCache || {});

export function getGlobalValue(key: string, def: unknown = null): unknown { return loadGlobal()[key] ?? def; }

export function setGlobalValue(key: string, val: unknown): boolean {
  const d = loadGlobal();
  d[key] = val;
  globalDataCache = d;
  return saveGlobal();
}

export function incrGlobalValue(key: string, amt: number = 1, def: number = 0): number {
  const d = loadGlobal(), v = fixNum(Number(d[key] ?? def) + amt);
  d[key] = v;
  globalDataCache = d;
  saveGlobal();
  return v;
}

// ==================== 排行榜 ====================

function extractScores(key: string): [string, number][] {
  const d = loadUser(), r: [string, number][] = [];
  for (const [uid, ud] of Object.entries(d)) { if (key in ud) { const v = Number(ud[key]); if (!isNaN(v)) r.push([uid, v]); } }
  return r;
}

export function getLeaderboard(key: string, limit = 10, asc = false): [string, number][] {
  const r = extractScores(key);
  r.sort((a, b) => asc ? a[1] - b[1] : b[1] - a[1]);
  return r.slice(0, limit);
}

export function getUserRank(uid: string, key: string, asc = false): { rank: number; value: number; total: number } {
  const r = extractScores(key);
  r.sort((a, b) => asc ? a[1] - b[1] : b[1] - a[1]);
  const i = r.findIndex(x => x[0] === uid);
  return { rank: i >= 0 ? i + 1 : 0, value: i >= 0 ? r[i][1] : 0, total: r.length };
}

export function countUsersWithKey(key: string): number { return Object.values(loadUser()).filter(d => key in d).length; }

// 清除缓存
export function clearCache(): void { workflowCache = null; userDataCache = null; globalDataCache = null; }
