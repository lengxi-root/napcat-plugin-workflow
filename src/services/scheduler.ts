// 工作流定时任务调度器
import fs from 'fs';
import path from 'path';
import type { MessageEvent, ReplyFunctions, ScheduledTask } from '../types';
import { pluginState } from '../core/state';
import { loadWorkflows } from './storage';
import { executeFromTrigger } from './executor';

export type { ScheduledTask };

// 状态
let tasks = new Map<string, ScheduledTask>();
let timer: ReturnType<typeof setInterval> | null = null;
let sender: ((type: string, id: string, msg: unknown[]) => Promise<void>) | null = null;
let caller: ((action: string, params: Record<string, unknown>) => Promise<unknown>) | null = null;

const tasksFile = () => path.join(pluginState.dataPath, 'scheduled_tasks.json');

// 存储操作
function load (): void {
  try {
    const f = tasksFile();
    if (fs.existsSync(f)) tasks = new Map(Object.entries(JSON.parse(fs.readFileSync(f, 'utf-8'))));
  } catch (e) { pluginState.log('error', '加载定时任务失败:', e); }
}

function save (): void {
  try {
    const f = tasksFile(), d = path.dirname(f);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(Object.fromEntries(tasks), null, 2), 'utf-8');
  } catch (e) { pluginState.log('error', '保存定时任务失败:', e); }
}

// 外部接口
export function setMessageSender (s: (type: string, id: string, msg: unknown[]) => Promise<void>, c?: (action: string, params: Record<string, unknown>) => Promise<unknown>): void {
  sender = s; if (c) caller = c;
}

export function startScheduler (): void { if (timer) return; load(); timer = setInterval(check, 60000); pluginState.log('info', '定时任务调度器已启动'); }
export function stopScheduler (): void { if (timer) { clearInterval(timer); timer = null; } }

// 检查并执行任务
async function check (): Promise<void> {
  const now = new Date(), time = now.toTimeString().slice(0, 5), day = now.getDay();

  for (const [id, t] of tasks) {
    if (!t.enabled) continue;
    let run = false;
    const last = t.last_run ? new Date(t.last_run) : null;

    if (t.task_type === 'daily' && t.daily_time === time) {
      if (!t.weekdays?.length || t.weekdays.includes(day)) run = !last || last.toDateString() !== now.toDateString();
    } else if (t.task_type === 'interval' && t.interval_seconds && t.interval_seconds > 0) {
      run = !last || (now.getTime() - last.getTime()) / 1000 >= t.interval_seconds;
    }
    if (run) await exec(id);
  }
}

// 执行任务
async function exec (id: string): Promise<void> {
  const t = tasks.get(id);
  if (!t || !sender) return;
  const wf = loadWorkflows().find(w => w.id === t.workflow_id);
  if (!wf?.enabled) return;

  try {
    const event: MessageEvent = { user_id: t.trigger_user_id || 'scheduled', group_id: t.target_type === 'group' ? t.target_id : undefined, message_type: t.target_type, raw_message: '__scheduled__', message: [], self_id: 0 };
    await executeFromTrigger(wf, event, createReply(t.target_type, t.target_id));
    t.last_run = new Date().toISOString();
    t.run_count = (t.run_count || 0) + 1;
    save();
    pluginState.log('info', `定时任务 [${id}] 执行成功`);
  } catch (e) { pluginState.log('error', `定时任务 [${id}] 执行失败:`, e); }
}

// 复用共享CQ解析工具
import { parseCQCode, toFile } from '../utils/cq-parser';

function createReply (type: string, id: string): ReplyFunctions {
  const send = async (msg: unknown[]) => { if (sender) await sender(type, id, msg).catch(() => { }); };
  const call = async (action: string, params: Record<string, unknown>) => caller ? await caller(action, params).catch(() => null) : null;
  const groupCall = async (action: string, params: Record<string, unknown>) => { if (type === 'group') await call(action, { group_id: id, ...params }).catch(() => { }); };

  return {
    reply: async (c) => send(parseCQCode(c)),
    replyImage: async (url, text) => { const m: unknown[] = [{ type: 'image', data: { file: toFile(url) } }]; if (text) m.push({ type: 'text', data: { text } }); await send(m); },
    replyVoice: async (url) => send([{ type: 'record', data: { file: toFile(url) } }]),
    replyVideo: async (url) => send([{ type: 'video', data: { file: toFile(url) } }]),
    replyForward: async (msgs) => send(msgs.map(c => ({ type: 'node', data: { user_id: '10000', nickname: '工作流', content: parseCQCode(c) } }))),
    replyAt: async (c) => send(parseCQCode(c)),
    replyFace: async (fid) => send([{ type: 'face', data: { id: String(fid) } }]),
    replyPoke: async () => { },
    replyJson: async (d) => send([{ type: 'json', data: { data: JSON.stringify(d) } }]),
    replyFile: async (url, name) => send([{ type: 'file', data: { file: url, name: name || 'file' } }]),
    replyMusic: async (t, mid) => send([{ type: 'music', data: { type: t, id: mid } }]),
    groupSign: () => groupCall('send_group_sign', {}),
    groupBan: (uid, dur) => groupCall('set_group_ban', { user_id: uid, duration: dur }),
    groupKick: (uid, reject = false) => groupCall('set_group_kick', { user_id: uid, reject_add_request: reject }),
    groupWholeBan: (enable) => groupCall('set_group_whole_ban', { enable }),
    groupSetCard: (uid, card) => groupCall('set_group_card', { user_id: uid, card }),
    groupSetAdmin: (uid, enable) => groupCall('set_group_admin', { user_id: uid, enable }),
    groupNotice: (c) => groupCall('_send_group_notice', { content: c }),
    recallMsg: async (msgId) => { await call('delete_msg', { message_id: msgId }).catch(() => { }); },
    callApi: call,
  };
}

// ==================== API ====================

type Result = { success: boolean; message?: string; error?: string; enabled?: boolean; };

export function addScheduledTask (t: Omit<ScheduledTask, 'run_count'>): Result {
  if (!t.id || !t.workflow_id || !t.target_id) return { success: false, error: '缺少参数' };
  if (t.task_type === 'daily' && !t.daily_time) return { success: false, error: '需指定 daily_time' };
  if (t.task_type === 'interval' && (!t.interval_seconds || t.interval_seconds < 60)) return { success: false, error: 'interval_seconds >= 60' };
  tasks.set(t.id, { ...t, run_count: 0 });
  save();
  return { success: true, message: `任务 [${t.id}] 已添加` };
}

export function removeScheduledTask (id: string): Result {
  if (tasks.has(id)) { tasks.delete(id); save(); return { success: true, message: '已删除' }; }
  return { success: false, error: '任务不存在' };
}

export function toggleScheduledTask (id: string): Result {
  const t = tasks.get(id);
  if (!t) return { success: false, error: '任务不存在' };
  t.enabled = !t.enabled; save();
  return { success: true, enabled: t.enabled };
}

export function getAllScheduledTasks (): ScheduledTask[] { return Array.from(tasks.values()); }
export function getScheduledTask (id: string): ScheduledTask | undefined { return tasks.get(id); }

export async function runScheduledTaskNow (id: string): Promise<Result> {
  if (!tasks.has(id)) return { success: false, error: '任务不存在' };
  await exec(id);
  return { success: true, message: '已执行' };
}
