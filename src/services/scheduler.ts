// 工作流定时任务调度器
import fs from 'fs';
import path from 'path';
import type { Workflow, WorkflowNode, WorkflowConnection, ExecutionContext, MessageEvent, ReplyFunctions } from '../types';
import { pluginState } from '../core/state';
import { loadWorkflows } from './storage';
import { executeFromTrigger } from './executor';

// 定时任务配置
export interface ScheduledTask {
  id: string;
  workflow_id: string;
  task_type: 'daily' | 'interval' | 'cron';
  daily_time?: string; // HH:MM
  interval_seconds?: number;
  weekdays?: number[]; // 0-6, 0=周日
  target_type: 'group' | 'private';
  target_id: string;
  trigger_user_id?: string; // 虚拟触发者QQ（用于条件判断）
  enabled: boolean;
  last_run?: string;
  run_count: number;
  description?: string;
}

// 内存缓存
let scheduledTasks: Map<string, ScheduledTask> = new Map();
let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let messageSender: ((type: string, id: string, messages: unknown[]) => Promise<void>) | null = null;
let apiCaller: ((action: string, params: Record<string, unknown>) => Promise<unknown>) | null = null;

const getTasksFile = () => path.join(pluginState.dataPath, 'scheduled_tasks.json');

// 加载定时任务
export function loadScheduledTasks (): void {
  try {
    const file = getTasksFile();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      scheduledTasks = new Map(Object.entries(data));
    }
  } catch (e) { pluginState.log('error', '加载定时任务失败:', e); }
}

// 保存定时任务
function saveScheduledTasks (): void {
  try {
    const file = getTasksFile();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(scheduledTasks), null, 2), 'utf-8');
  } catch (e) { pluginState.log('error', '保存定时任务失败:', e); }
}

// 设置消息发送器
export function setMessageSender (
  sender: (type: string, id: string, messages: unknown[]) => Promise<void>,
  caller?: (action: string, params: Record<string, unknown>) => Promise<unknown>
): void {
  messageSender = sender;
  if (caller) apiCaller = caller;
}

// 启动调度器
export function startScheduler (): void {
  if (schedulerInterval) return;
  loadScheduledTasks();
  schedulerInterval = setInterval(checkAndExecuteTasks, 60000);
  pluginState.log('info', '定时任务调度器已启动');
}

// 停止调度器
export function stopScheduler (): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

// 检查并执行任务
async function checkAndExecuteTasks (): Promise<void> {
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);
  const currentDay = now.getDay();

  for (const [taskId, task] of scheduledTasks) {
    if (!task.enabled) continue;
    let shouldExecute = false;

    if (task.task_type === 'daily' && task.daily_time === currentTime) {
      if (!task.weekdays || task.weekdays.length === 0 || task.weekdays.includes(currentDay)) {
        const lastRun = task.last_run ? new Date(task.last_run) : null;
        if (!lastRun || lastRun.toDateString() !== now.toDateString()) shouldExecute = true;
      }
    } else if (task.task_type === 'interval' && task.interval_seconds && task.interval_seconds > 0) {
      const lastRun = task.last_run ? new Date(task.last_run) : null;
      if (lastRun) {
        if ((now.getTime() - lastRun.getTime()) / 1000 >= task.interval_seconds) shouldExecute = true;
      } else { shouldExecute = true; }
    }

    if (shouldExecute) await executeScheduledTask(taskId);
  }
}

// 执行定时任务（跳过触发器判断，直接执行后续节点）
async function executeScheduledTask (taskId: string): Promise<void> {
  const task = scheduledTasks.get(taskId);
  if (!task || !messageSender) return;

  const workflow = loadWorkflows().find(w => w.id === task.workflow_id);
  if (!workflow || !workflow.enabled) return;

  try {
    // 创建虚拟事件（使用配置的虚拟触发者）
    const event: MessageEvent = {
      user_id: task.trigger_user_id || 'scheduled',
      group_id: task.target_type === 'group' ? task.target_id : undefined,
      message_type: task.target_type,
      raw_message: '__scheduled__',
      message: [],
      self_id: 0,
    };

    const reply = createScheduledReply(task.target_type, task.target_id);
    
    // 直接从触发器后续节点执行（跳过触发器判断）
    await executeFromTrigger(workflow, event, reply);

    task.last_run = new Date().toISOString();
    task.run_count = (task.run_count || 0) + 1;
    saveScheduledTasks();
    pluginState.log('info', `定时任务 [${taskId}] 执行成功`);
  } catch (e) { pluginState.log('error', `定时任务 [${taskId}] 执行失败:`, e); }
}

// 创建定时任务的回复函数
function createScheduledReply (targetType: string, targetId: string): ReplyFunctions {
  const sendMsg = async (messages: unknown[]) => { if (messageSender) await messageSender(targetType, targetId, messages); };
  const callApi = async (action: string, params: Record<string, unknown>) => apiCaller ? await apiCaller(action, params) : null;

  return {
    reply: async (content: string) => sendMsg([{ type: 'text', data: { text: content } }]),
    replyImage: async (url: string | Buffer, text?: string) => {
      const msg: unknown[] = [{ type: 'image', data: { file: typeof url === 'string' ? url : `base64://${url.toString('base64')}` } }];
      if (text) msg.push({ type: 'text', data: { text } });
      await sendMsg(msg);
    },
    replyVoice: async (url: string | Buffer) => sendMsg([{ type: 'record', data: { file: typeof url === 'string' ? url : `base64://${url.toString('base64')}` } }]),
    replyVideo: async (url: string | Buffer) => sendMsg([{ type: 'video', data: { file: typeof url === 'string' ? url : `base64://${url.toString('base64')}` } }]),
    replyForward: async (messages: string[]) => sendMsg(messages.map(c => ({ type: 'node', data: { user_id: '10000', nickname: '工作流', content: [{ type: 'text', data: { text: c } }] } }))),
    replyAt: async (content: string) => sendMsg([{ type: 'text', data: { text: content } }]),
    replyFace: async (faceId: number) => sendMsg([{ type: 'face', data: { id: String(faceId) } }]),
    replyPoke: async () => { },
    replyJson: async (data: unknown) => sendMsg([{ type: 'json', data: { data: JSON.stringify(data) } }]),
    replyFile: async (url: string, name?: string) => sendMsg([{ type: 'file', data: { file: url, name: name || 'file' } }]),
    replyMusic: async (type: string, id: string) => sendMsg([{ type: 'music', data: { type, id } }]),
    groupSign: async () => { if (targetType === 'group') await callApi('send_group_sign', { group_id: targetId }); },
    groupBan: async (userId: string, duration: number) => { if (targetType === 'group') await callApi('set_group_ban', { group_id: targetId, user_id: userId, duration }); },
    groupKick: async (userId: string, rejectAdd = false) => { if (targetType === 'group') await callApi('set_group_kick', { group_id: targetId, user_id: userId, reject_add_request: rejectAdd }); },
    groupWholeBan: async (enable: boolean) => { if (targetType === 'group') await callApi('set_group_whole_ban', { group_id: targetId, enable }); },
    groupSetCard: async (userId: string, card: string) => { if (targetType === 'group') await callApi('set_group_card', { group_id: targetId, user_id: userId, card }); },
    groupSetAdmin: async (userId: string, enable: boolean) => { if (targetType === 'group') await callApi('set_group_admin', { group_id: targetId, user_id: userId, enable }); },
    groupNotice: async (content: string) => { if (targetType === 'group') await callApi('_send_group_notice', { group_id: targetId, content }); },
    callApi,
  };
}

// ==================== API ====================

export function addScheduledTask (task: Omit<ScheduledTask, 'run_count'>): { success: boolean; message?: string; error?: string; } {
  if (!task.id || !task.workflow_id || !task.target_id) return { success: false, error: '缺少必要参数' };
  if (task.task_type === 'daily' && !task.daily_time) return { success: false, error: '每日任务需要指定 daily_time' };
  if (task.task_type === 'interval' && (!task.interval_seconds || task.interval_seconds < 60)) return { success: false, error: '间隔任务需要 interval_seconds >= 60' };
  scheduledTasks.set(task.id, { ...task, run_count: 0 });
  saveScheduledTasks();
  return { success: true, message: `定时任务 [${task.id}] 已添加` };
}

export function removeScheduledTask (taskId: string): { success: boolean; message?: string; error?: string; } {
  if (scheduledTasks.has(taskId)) { scheduledTasks.delete(taskId); saveScheduledTasks(); return { success: true, message: '已删除' }; }
  return { success: false, error: '任务不存在' };
}

export function toggleScheduledTask (taskId: string): { success: boolean; enabled?: boolean; error?: string; } {
  const task = scheduledTasks.get(taskId);
  if (!task) return { success: false, error: '任务不存在' };
  task.enabled = !task.enabled;
  saveScheduledTasks();
  return { success: true, enabled: task.enabled };
}

export function getAllScheduledTasks (): ScheduledTask[] { return Array.from(scheduledTasks.values()); }
export function getScheduledTask (taskId: string): ScheduledTask | undefined { return scheduledTasks.get(taskId); }

export async function runScheduledTaskNow (taskId: string): Promise<{ success: boolean; message?: string; error?: string; }> {
  if (!scheduledTasks.has(taskId)) return { success: false, error: '任务不存在' };
  await executeScheduledTask(taskId);
  return { success: true, message: '已执行' };
}
