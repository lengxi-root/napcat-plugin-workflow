// 工作流数据存储模块
import fs from 'fs';
import path from 'path';
import type { Workflow } from '../types';
import { pluginState } from '../core/state';

const getFilePath = (name: string) => path.join(pluginState.dataPath, name);

// 内存缓存
let workflowCache: Workflow[] | null = null;
let userDataCache: Record<string, Record<string, unknown>> | null = null;
let globalDataCache: Record<string, unknown> | null = null;
let workflowWatcher: fs.FSWatcher | null = null;

function ensureDir (filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ==================== 工作流存储 ====================

// 启动文件监听
export function startWorkflowWatcher (): void {
  if (workflowWatcher) return;
  const filePath = getFilePath('workflows.json');
  ensureDir(filePath);
  
  // 确保文件存在
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '[]', 'utf-8');
  }

  try {
    workflowWatcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') {
        workflowCache = null; // 清除缓存，下次访问时重新加载
        pluginState.log('debug', '工作流配置已更新');
      }
    });
  } catch (e) {
    pluginState.log('debug', '无法启动文件监听，将使用轮询模式');
  }
}

// 停止文件监听
export function stopWorkflowWatcher (): void {
  if (workflowWatcher) {
    workflowWatcher.close();
    workflowWatcher = null;
  }
}

export function loadWorkflows (): Workflow[] {
  if (workflowCache) return workflowCache;
  try {
    const filePath = getFilePath('workflows.json');
    if (fs.existsSync(filePath)) {
      workflowCache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return workflowCache || [];
    }
  } catch (e) { pluginState.log('error', '加载工作流失败:', e); }
  return [];
}

export function saveWorkflows (workflows: Workflow[]): boolean {
  try {
    const filePath = getFilePath('workflows.json');
    ensureDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(workflows, null, 2), 'utf-8');
    workflowCache = workflows;
    return true;
  } catch (e) { pluginState.log('error', '保存工作流失败:', e); return false; }
}

export function getWorkflowById (id: string): Workflow | undefined {
  return loadWorkflows().find(w => w.id === id);
}

export function deleteWorkflow (id: string): boolean {
  const workflows = loadWorkflows().filter(w => w.id !== id);
  return saveWorkflows(workflows);
}

export function toggleWorkflow (id: string): boolean {
  const workflows = loadWorkflows();
  const wf = workflows.find(w => w.id === id);
  if (wf) { wf.enabled = !wf.enabled; return saveWorkflows(workflows); }
  return false;
}

// ==================== 用户数据存储 ====================

function loadUserData (): Record<string, Record<string, unknown>> {
  if (userDataCache) return userDataCache;
  try {
    const filePath = getFilePath('user_data.json');
    if (fs.existsSync(filePath)) {
      userDataCache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return userDataCache || {};
    }
  } catch { }
  return {};
}

function saveUserData (): boolean {
  try {
    const filePath = getFilePath('user_data.json');
    ensureDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(userDataCache || {}, null, 2), 'utf-8');
    return true;
  } catch { return false; }
}

export function getUserValue (userId: string, key: string, defaultValue: unknown = null): unknown {
  const data = loadUserData();
  return data[userId]?.[key] ?? defaultValue;
}

export function setUserValue (userId: string, key: string, value: unknown): boolean {
  const data = loadUserData();
  if (!data[userId]) data[userId] = {};
  data[userId][key] = value;
  userDataCache = data;
  return saveUserData();
}

export function incrUserValue (userId: string, key: string, amount: number = 1, defaultValue: number = 0): number {
  const data = loadUserData();
  if (!data[userId]) data[userId] = {};
  const current = Number(data[userId][key] ?? defaultValue);
  const newValue = current + amount;
  data[userId][key] = Number.isInteger(newValue) ? newValue : parseFloat(newValue.toFixed(2));
  userDataCache = data;
  saveUserData();
  return data[userId][key] as number;
}

export function deleteUserValue (userId: string, key: string): boolean {
  const data = loadUserData();
  if (data[userId] && key in data[userId]) {
    delete data[userId][key];
    userDataCache = data;
    return saveUserData();
  }
  return false;
}

// ==================== 全局数据存储 ====================

function loadGlobalData (): Record<string, unknown> {
  if (globalDataCache) return globalDataCache;
  try {
    const filePath = getFilePath('global_data.json');
    if (fs.existsSync(filePath)) {
      globalDataCache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return globalDataCache || {};
    }
  } catch { }
  return {};
}

function saveGlobalData (): boolean {
  try {
    const filePath = getFilePath('global_data.json');
    ensureDir(filePath);
    fs.writeFileSync(filePath, JSON.stringify(globalDataCache || {}, null, 2), 'utf-8');
    return true;
  } catch { return false; }
}

export function getGlobalValue (key: string, defaultValue: unknown = null): unknown {
  return loadGlobalData()[key] ?? defaultValue;
}

export function setGlobalValue (key: string, value: unknown): boolean {
  const data = loadGlobalData();
  data[key] = value;
  globalDataCache = data;
  return saveGlobalData();
}

export function incrGlobalValue (key: string, amount: number = 1, defaultValue: number = 0): number {
  const data = loadGlobalData();
  const current = Number(data[key] ?? defaultValue);
  const newValue = current + amount;
  data[key] = Number.isInteger(newValue) ? newValue : parseFloat(newValue.toFixed(2));
  globalDataCache = data;
  saveGlobalData();
  return data[key] as number;
}

// ==================== 排行榜 ====================

export function getLeaderboard (key: string, limit: number = 10, ascending: boolean = false): [string, number][] {
  const data = loadUserData();
  const results: [string, number][] = [];
  for (const [userId, userData] of Object.entries(data)) {
    if (key in userData) {
      const value = Number(userData[key]);
      if (!isNaN(value)) results.push([userId, value]);
    }
  }
  results.sort((a, b) => ascending ? a[1] - b[1] : b[1] - a[1]);
  return results.slice(0, limit);
}

export function getUserRank (userId: string, key: string, ascending: boolean = false): { rank: number; value: number; total: number; } {
  const data = loadUserData();
  const results: [string, number][] = [];
  for (const [uid, userData] of Object.entries(data)) {
    if (key in userData) {
      const value = Number(userData[key]);
      if (!isNaN(value)) results.push([uid, value]);
    }
  }
  results.sort((a, b) => ascending ? a[1] - b[1] : b[1] - a[1]);
  const idx = results.findIndex(r => r[0] === userId);
  return { rank: idx >= 0 ? idx + 1 : 0, value: idx >= 0 ? results[idx][1] : 0, total: results.length };
}

export function countUsersWithKey (key: string): number {
  const data = loadUserData();
  return Object.values(data).filter(d => key in d).length;
}

// 清除缓存
export function clearCache (): void {
  workflowCache = null;
  userDataCache = null;
  globalDataCache = null;
}
