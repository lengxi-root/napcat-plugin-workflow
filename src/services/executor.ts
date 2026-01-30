// 工作流执行器
import type { Workflow, WorkflowNode, WorkflowConnection, ExecutionContext, MessageEvent, ReplyFunctions } from '../types';
import { pluginState } from '../core/state';
import * as storage from './storage';

// 检查触发条件
function checkTrigger (node: WorkflowNode, content: string): string[] | null {
  const data = node.data;
  const triggerType = (data.trigger_type || 'exact') as string;
  const triggerValue = (data.trigger_content || data.trigger_value || '') as string;

  if (triggerType === 'scheduled' || triggerType === 'timer' || content === '__scheduled_trigger__') return [];
  if (!triggerValue) return null;

  if (triggerType === 'exact') return content === triggerValue ? [] : null;
  if (triggerType === 'contains') return content.includes(triggerValue) ? [] : null;
  if (triggerType === 'startswith') return content.startsWith(triggerValue) ? [] : null;
  if (triggerType === 'regex') {
    try { const m = content.match(new RegExp(triggerValue)); return m ? Array.from(m).slice(1) : null; } catch { return null; }
  }
  if (triggerType === 'any') {
    return triggerValue.split('|').map(k => k.trim()).filter(Boolean).some(kw => content.includes(kw)) ? [] : null;
  }
  return null;
}

// 检查条件
function checkCondition (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext): boolean {
  const condType = (data.condition_type || 'contains') as string;
  const condValue = replaceVars((data.condition_value || '') as string, event, content, ctx);
  const varName = (data.var_name || '') as string;

  switch (condType) {
    case 'contains': return content.includes(condValue);
    case 'equals': return content === condValue;
    case 'regex': try { return new RegExp(condValue).test(content); } catch { return false; }
    case 'random': return Math.random() * 100 < parseFloat(condValue);
    case 'user_id': return event.user_id === condValue;
    case 'group_id': return event.group_id === condValue;
    case 'var_equals': return String(ctx[varName]) === condValue;
    case 'var_gt': return Number(ctx[varName] || 0) > Number(condValue);
    case 'var_lt': return Number(ctx[varName] || 0) < Number(condValue);
    case 'data_equals': { const [k, v] = condValue.split('='); return String(storage.getUserValue(event.user_id, k?.trim() || '', '')) === v?.trim(); }
    case 'data_gt': { const [k, v] = condValue.split('>'); return Number(storage.getUserValue(event.user_id, k?.trim() || '', 0)) > Number(v?.trim()); }
    case 'data_lt': { const [k, v] = condValue.split('<'); return Number(storage.getUserValue(event.user_id, k?.trim() || '', 0)) < Number(v?.trim()); }
    case 'data_is_today': return String(storage.getUserValue(event.user_id, condValue, '')) === new Date().toISOString().split('T')[0];
    case 'cooldown': { const [k, s] = condValue.split(','); return (Date.now() / 1000 - Number(storage.getUserValue(event.user_id, k?.trim() || '', 0))) >= Number(s?.trim() || 0); }
    case 'time_range': { const [start, end] = condValue.split('-').map(s => parseInt(s.trim())); const h = new Date().getHours(); return start <= end ? (h >= start && h <= end) : (h >= start || h <= end); }
    case 'weekday_in': { const days = condValue.split('|').map(d => d.trim()); const dayMap: Record<string, number> = { '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 0 }; return days.some(d => (dayMap[d] ?? parseInt(d)) === new Date().getDay()); }
    case 'global_equals': { const [k, v] = condValue.split('='); return String(storage.getGlobalValue(k?.trim() || '', '')) === v?.trim(); }
    case 'global_gt': { const [k, v] = condValue.split('>'); return Number(storage.getGlobalValue(k?.trim() || '', 0)) > Number(v?.trim()); }
    case 'expression': { try { return Boolean(eval(replaceVars(condValue, event, content, ctx).replace(/==/g, '===').replace(/!=/g, '!=='))); } catch { return false; } }
    default: return true;
  }
}

// 执行存储操作
function executeStorage (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext): void {
  const type = (data.storage_type || 'get') as string, key = replaceVars((data.storage_key || '') as string, event, content, ctx);
  const value = replaceVars((data.storage_value || '') as string, event, content, ctx), resultVar = (data.result_var || 'data_result') as string;
  if (!key) return;
  if (type === 'get') ctx[resultVar] = storage.getUserValue(event.user_id, key, data.default_value ?? 0);
  else if (type === 'set') { storage.setUserValue(event.user_id, key, parseValue(value)); ctx[resultVar] = value; }
  else if (type === 'incr') ctx[resultVar] = storage.incrUserValue(event.user_id, key, Number(value) || 1, Number(data.default_value ?? 0));
  else if (type === 'decr') ctx[resultVar] = storage.incrUserValue(event.user_id, key, -(Number(value) || 1), Number(data.default_value ?? 0));
  else if (type === 'delete') { storage.deleteUserValue(event.user_id, key); ctx[resultVar] = ''; }
}

// 执行全局存储
function executeGlobalStorage (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext): void {
  const type = (data.storage_type || 'get') as string, key = replaceVars((data.storage_key || '') as string, event, content, ctx);
  const value = replaceVars((data.storage_value || '') as string, event, content, ctx), resultVar = (data.result_var || 'global_result') as string;
  if (!key) return;
  if (type === 'get') ctx[resultVar] = storage.getGlobalValue(key, data.default_value ?? 0);
  else if (type === 'set') { storage.setGlobalValue(key, parseValue(value)); ctx[resultVar] = value; }
  else if (type === 'incr') ctx[resultVar] = storage.incrGlobalValue(key, Number(value) || 1, Number(data.default_value ?? 0));
  else if (type === 'decr') ctx[resultVar] = storage.incrGlobalValue(key, -(Number(value) || 1), Number(data.default_value ?? 0));
}

// 执行排行榜
function executeLeaderboard (data: Record<string, unknown>, event: MessageEvent, ctx: ExecutionContext): void {
  const type = (data.leaderboard_type || 'top') as string, key = (data.leaderboard_key || 'score') as string;
  const limit = Number(data.limit || 10), ascending = data.ascending === 'true' || data.ascending === true;
  if (type === 'top') {
    const results = storage.getLeaderboard(key, limit, ascending);
    ctx.leaderboard = results.map(([uid, val], i) => `${i + 1}. ${uid.slice(0, 8)}... : ${Number.isInteger(val) ? val : val.toFixed(2)}`).join('\n');
    ctx.leaderboard_list = results;
  } else if (type === 'my_rank') {
    const { rank, value, total } = storage.getUserRank(event.user_id, key, ascending);
    ctx.my_rank = rank; ctx.my_value = value; ctx.total_users = total;
  } else if (type === 'count') { ctx.user_count = storage.countUsersWithKey(key); }
}

// 执行数学运算
function executeMath (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext): void {
  const type = (data.math_type || 'add') as string;
  const a = Number(replaceVars((data.operand1 || '0') as string, event, content, ctx));
  const b = Number(replaceVars((data.operand2 || '0') as string, event, content, ctx));
  let result: number;
  switch (type) {
    case 'add': result = a + b; break; case 'sub': result = a - b; break; case 'mul': result = a * b; break;
    case 'div': result = b !== 0 ? a / b : 0; break; case 'mod': result = b !== 0 ? a % b : 0; break;
    case 'pow': result = Math.pow(a, b); break; case 'min': result = Math.min(a, b); break; case 'max': result = Math.max(a, b); break;
    case 'random': result = Math.floor(Math.random() * (b - a + 1)) + a; break; default: result = a;
  }
  ctx[(data.result_var || 'math_result') as string] = Number.isInteger(result) ? result : parseFloat(result.toFixed(2));
}

// 执行字符串操作
function executeStringOp (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext): void {
  const type = (data.string_type || 'concat') as string;
  const input1 = replaceVars((data.input1 || '') as string, event, content, ctx);
  const input2 = replaceVars((data.input2 || '') as string, event, content, ctx);
  const resultVar = (data.result_var || 'string_result') as string;
  let result: string | number;
  switch (type) {
    case 'concat': result = input1 + input2; break;
    case 'replace': result = input1.replace(new RegExp(data.target as string || '', 'g'), input2); break;
    case 'split': const parts = input1.split(input2 || '|'); ctx.split_list = parts; ctx.split_count = parts.length; result = parts[0] || ''; break;
    case 'substr': { const [s, e] = (input2 || '0').split(',').map(x => parseInt(x.trim())); result = e ? input1.slice(s, e) : input1.slice(s); break; }
    case 'length': result = input1.length; break; case 'upper': result = input1.toUpperCase(); break;
    case 'lower': result = input1.toLowerCase(); break; case 'trim': result = input1.trim(); break;
    case 'contains': result = input1.includes(input2) ? '1' : '0'; ctx.contains = input1.includes(input2); break;
    case 'repeat': result = input1.repeat(Math.min(parseInt(input2) || 1, 100)); break; default: result = input1;
  }
  ctx[resultVar] = result;
}

// 执行随机抽取
function executeListRandom (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext): void {
  const items = replaceVars((data.list_items || '') as string, event, content, ctx).split('|').map(s => s.trim()).filter(Boolean);
  const resultVar = (data.result_var || 'list_result') as string, indexVar = (data.index_var || 'list_index') as string;
  if (!items.length) { ctx[resultVar] = ''; ctx[indexVar] = -1; return; }
  const weightsStr = (data.weights || '') as string;
  if (weightsStr) {
    const weights = weightsStr.split('|').map(w => parseFloat(w.trim()));
    if (weights.length === items.length) {
      const total = weights.reduce((a, b) => a + b, 0); let r = Math.random() * total, cumulative = 0;
      for (let i = 0; i < weights.length; i++) { cumulative += weights[i]; if (r <= cumulative) { ctx[resultVar] = items[i]; ctx[indexVar] = i; return; } }
    }
  }
  const idx = Math.floor(Math.random() * items.length); ctx[resultVar] = items[idx]; ctx[indexVar] = idx;
}

// 执行动作
async function executeAction (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext, reply: ReplyFunctions): Promise<void> {
  const actionType = (data.action_type || 'reply_text') as string;
  const actionValue = replaceVars((data.action_value || '') as string, event, content, ctx);

  switch (actionType) {
    case 'reply_text': { const replies = actionValue.split('|||').map(s => s.trim()).filter(Boolean); await reply.reply(replies.length ? replies[Math.floor(Math.random() * replies.length)] : actionValue); break; }
    case 'reply_image': await reply.replyImage(actionValue, replaceVars((data.image_text || '') as string, event, content, ctx) || undefined); break;
    case 'reply_voice': await reply.replyVoice(actionValue); break;
    case 'reply_video': await reply.replyVideo(actionValue); break;
    case 'reply_at': await reply.replyAt(actionValue); break;
    case 'reply_face': await reply.replyFace(parseInt(actionValue) || 0); break;
    case 'reply_poke': await reply.replyPoke(actionValue || event.user_id); break;
    case 'reply_json': try { await reply.replyJson(JSON.parse(actionValue)); } catch { await reply.reply(actionValue); } break;
    case 'reply_file': await reply.replyFile(actionValue, replaceVars((data.file_name || '') as string, event, content, ctx) || undefined); break;
    case 'reply_music': await reply.replyMusic((data.music_type || 'qq') as string, actionValue); break;
    case 'reply_forward': await reply.replyForward(actionValue.split('|||').map(s => s.trim()).filter(Boolean)); break;
    case 'custom_api': await executeCustomApi(data, event, content, ctx, reply); break;
    case 'math': executeMath(data, event, content, ctx); break;
    case 'string_op': executeStringOp(data, event, content, ctx); break;
    case 'group_sign': await reply.groupSign().catch(() => {}); break;
    case 'group_ban': await reply.groupBan(replaceVars((data.target_user || '{user_id}') as string, event, content, ctx), parseInt(replaceVars((data.ban_duration || '600') as string, event, content, ctx)) || 600).catch(() => {}); break;
    case 'group_kick': await reply.groupKick(replaceVars((data.target_user || '{user_id}') as string, event, content, ctx), data.reject_add === true || data.reject_add === 'true').catch(() => {}); break;
    case 'group_whole_ban': await reply.groupWholeBan(data.enable_ban === true || data.enable_ban === 'true').catch(() => {}); break;
    case 'group_set_card': await reply.groupSetCard(replaceVars((data.target_user || '{user_id}') as string, event, content, ctx), replaceVars((data.card_value || '') as string, event, content, ctx)).catch(() => {}); break;
    case 'group_set_admin': await reply.groupSetAdmin(replaceVars((data.target_user || '{user_id}') as string, event, content, ctx), data.enable_admin === true || data.enable_admin === 'true').catch(() => {}); break;
    case 'group_notice': await reply.groupNotice(actionValue).catch(() => {}); break;
    case 'call_api': { let params: Record<string, unknown> = {}; try { params = JSON.parse(replaceVars((data.api_params || '{}') as string, event, content, ctx)); } catch {} const result = await reply.callApi(replaceVars((data.api_action || '') as string, event, content, ctx), params); if (data.result_var) ctx[data.result_var as string] = result; break; }
  }
}

// 执行自定义API
async function executeCustomApi (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext, reply: ReplyFunctions): Promise<void> {
  const apiUrl = replaceVars((data.api_url || '') as string, event, content, ctx);
  const method = ((data.api_method || 'GET') as string).toUpperCase();
  const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
  const headersStr = (data.api_headers || '') as string;
  if (headersStr) { try { Object.assign(headers, JSON.parse(headersStr)); } catch { headersStr.split('\n').forEach(l => { const [k, v] = l.split(':'); if (k && v) headers[k.trim()] = replaceVars(v.trim(), event, content, ctx); }); } }
  const bodyStr = (data.api_body || '') as string;
  const body = bodyStr && ['POST', 'PUT', 'PATCH'].includes(method) ? replaceVars(bodyStr, event, content, ctx) : undefined;

  try {
    const res = await fetch(apiUrl, { method, headers, body, signal: AbortSignal.timeout(Number(data.api_timeout || 10) * 1000) });
    ctx.api_status = res.status;
    const responseType = (data.response_type || 'json') as string;
    if (responseType === 'json') { try { ctx.api_json = await res.json(); ctx.api_response = JSON.stringify(ctx.api_json); } catch { ctx.api_response = await res.text(); } }
    else if (responseType === 'binary') { ctx.api_binary = Buffer.from(await res.arrayBuffer()); ctx.api_response = apiUrl; }
    else { ctx.api_response = await res.text(); }

    const replyType = (data.reply_type || 'text') as string, template = (data.api_reply || '') as string;
    const text = template ? processTemplate(template, event, content, ctx) : String(ctx.api_response);
    if (replyType === 'text' || !replyType) await reply.reply(text);
    else if (replyType === 'image') await reply.replyImage(responseType === 'binary' && ctx.api_binary ? ctx.api_binary as Buffer : text, replaceVars((data.image_text || '') as string, event, content, ctx) || undefined);
    else if (replyType === 'voice') await reply.replyVoice(responseType === 'binary' && ctx.api_binary ? ctx.api_binary as Buffer : text);
    else if (replyType === 'video') await reply.replyVideo(responseType === 'binary' && ctx.api_binary ? ctx.api_binary as Buffer : text);
    else if (replyType === 'forward') await reply.replyForward(text.split('|||').map(s => s.trim()).filter(Boolean));
  } catch (e: any) { await reply.reply(`API调用失败: ${e.message || '请求超时'}`); }
}

// 处理模板
function processTemplate (template: string, event: MessageEvent, content: string, ctx: ExecutionContext): string {
  let result = replaceVars(template, event, content, ctx);
  const apiJson = ctx.api_json as Record<string, unknown> | undefined;
  if (apiJson) { result = result.replace(/\{([^}]+)\}/g, (_, path) => ['user_id', 'group_id', 'content', 'message', 'api_response', 'api_status'].includes(path) || path.startsWith('$') ? _ : String(extractJsonPath(apiJson, path.trim()))); }
  return result;
}

// 提取 JSON 路径
function extractJsonPath (data: Record<string, unknown>, path: string): unknown {
  try {
    let result: unknown = data;
    for (const part of path.split('.')) { const m = part.match(/^([^[]+)(?:\[(\d+)\])?$/); if (!m) return ''; if (m[1]) result = (result as Record<string, unknown>)?.[m[1]]; if (m[2] !== undefined) result = (result as unknown[])?.[parseInt(m[2])]; }
    return result ?? '';
  } catch { return ''; }
}

// 替换变量
function replaceVars (text: string, event: MessageEvent, content: string, ctx: ExecutionContext): string {
  if (!text || !text.includes('{')) return text;
  const now = new Date();
  const vars: Record<string, string> = {
    '{user_id}': event.user_id, '{group_id}': event.group_id || '', '{content}': content, '{message}': content,
    '{date}': now.toISOString().split('T')[0], '{today}': now.toISOString().split('T')[0], '{time}': now.toTimeString().split(' ')[0],
    '{datetime}': now.toISOString().replace('T', ' ').split('.')[0], '{timestamp}': String(Math.floor(Date.now() / 1000)),
    '{year}': String(now.getFullYear()), '{month}': String(now.getMonth() + 1), '{day}': String(now.getDate()),
    '{hour}': String(now.getHours()), '{minute}': String(now.getMinutes()), '{weekday}': String(now.getDay()),
    '{weekday_cn}': ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()],
    '{random}': String(Math.floor(Math.random() * 100) + 1), '{random100}': String(Math.floor(Math.random() * 100) + 1),
    '{random10}': String(Math.floor(Math.random() * 10) + 1), '{random6}': String(Math.floor(Math.random() * 6) + 1),
    '{at_user}': `[CQ:at,qq=${event.user_id}]`,
  };
  for (const [k, v] of Object.entries(vars)) text = text.replace(new RegExp(k.replace(/[{}]/g, '\\$&'), 'g'), v);
  ctx.regex_groups?.forEach((g, i) => { text = text.replace(new RegExp(`\\{\\$${i + 1}\\}`, 'g'), g || ''); });
  for (const [k, v] of Object.entries(ctx)) { if (k !== 'regex_groups' && k !== 'api_binary') text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v ?? '')); }
  text = text.replace(/\{storage\.([^}]+)\}/g, (_, key) => String(storage.getUserValue(event.user_id, key, '')));
  return text;
}

// 解析值
function parseValue (value: string): unknown {
  if (/^-?\d+$/.test(value)) return parseInt(value);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  if (value === 'true') return true; if (value === 'false') return false;
  return value;
}

// 规范化连接格式
function normalizeConnections (workflow: Workflow): WorkflowConnection[] {
  return (workflow.connections || []).map(c => {
    let fromOutput = (c as any).from_output || (c as any).port || 'output_1';
    if (fromOutput === 'output') fromOutput = 'output_1';
    else if (fromOutput === 'output-1') fromOutput = 'output_1';
    else if (fromOutput === 'output-2') fromOutput = 'output_2';
    return { from_node: (c as any).from_node || (c as any).from, to_node: (c as any).to_node || (c as any).to, from_output: fromOutput };
  });
}

// 从节点执行
async function runFromNode (nodeId: string, nodes: Map<string, WorkflowNode>, connections: WorkflowConnection[], event: MessageEvent, content: string, ctx: ExecutionContext, reply: ReplyFunctions): Promise<boolean> {
  const node = nodes.get(nodeId);
  if (!node) return false;
  const { type, data } = node;
  let result = true;

  pluginState.log('debug', `执行节点: ${nodeId} type=${type}`);

  try {
    if (type === 'condition') result = checkCondition(data, event, content, ctx);
    else if (type === 'action') await executeAction(data, event, content, ctx, reply);
    else if (type === 'delay') await new Promise(r => setTimeout(r, Math.min(Number(data.seconds || 1), 10) * 1000));
    else if (type === 'set_var') { const vn = (data.var_name || '') as string; if (vn) ctx[vn] = replaceVars((data.var_value || '') as string, event, content, ctx); }
    else if (type === 'storage') executeStorage(data, event, content, ctx);
    else if (type === 'global_storage') executeGlobalStorage(data, event, content, ctx);
    else if (type === 'leaderboard') executeLeaderboard(data, event, ctx);
    else if (type === 'list_random') executeListRandom(data, event, content, ctx);
  } catch (e) { pluginState.log('error', `节点 ${nodeId} 执行失败:`, e); }

  const nextConns = result
    ? connections.filter(c => c.from_node === nodeId && ['output_1', 'output-1', 'output'].includes(c.from_output || 'output_1'))
    : connections.filter(c => c.from_node === nodeId && ['output_2', 'output-2'].includes(c.from_output));

  for (const conn of nextConns) await runFromNode(conn.to_node, nodes, connections, event, content, ctx, reply);
  return true;
}

// 执行工作流（需要匹配触发器）
export async function execute (workflow: Workflow, event: MessageEvent, content: string, reply: ReplyFunctions): Promise<boolean> {
  const nodesMap = new Map<string, WorkflowNode>();
  (workflow.nodes || []).forEach(n => nodesMap.set(n.id, n));
  const connections = normalizeConnections(workflow);

  const triggers = Array.from(nodesMap.values()).filter(n => n.type === 'trigger');
  for (const trigger of triggers) {
    const groups = checkTrigger(trigger, content);
    if (groups !== null) {
      pluginState.log('debug', `触发器 ${trigger.id} 匹配成功`);
      return await runFromNode(trigger.id, nodesMap, connections, event, content, { regex_groups: groups }, reply);
    }
  }
  return false;
}

// 从触发器执行（跳过触发器判断，用于定时任务）
export async function executeFromTrigger (workflow: Workflow, event: MessageEvent, reply: ReplyFunctions): Promise<boolean> {
  const nodesMap = new Map<string, WorkflowNode>();
  (workflow.nodes || []).forEach(n => nodesMap.set(n.id, n));
  const connections = normalizeConnections(workflow);

  // 找到触发器节点，直接执行其后续节点
  const triggers = Array.from(nodesMap.values()).filter(n => n.type === 'trigger');
  if (!triggers.length) return false;

  const ctx: ExecutionContext = { regex_groups: [] };
  let executed = false;

  for (const trigger of triggers) {
    // 找到触发器的后续连接，直接执行后续节点
    const nextConns = connections.filter(c => c.from_node === trigger.id && ['output_1', 'output-1', 'output'].includes(c.from_output || 'output_1'));
    for (const conn of nextConns) {
      await runFromNode(conn.to_node, nodesMap, connections, event, '', ctx, reply);
      executed = true;
    }
  }
  return executed;
}
