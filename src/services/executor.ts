// 工作流执行器
import type { Workflow, WorkflowNode, WorkflowConnection, ExecutionContext, MessageEvent, ReplyFunctions } from '../types';
import { pluginState } from '../core/state';
import * as storage from './storage';

// 检查触发条件
function checkTrigger (node: WorkflowNode, content: string): string[] | null {
  const { trigger_type: type = 'exact', trigger_content, trigger_value } = node.data as Record<string, string>;
  const val = trigger_content || trigger_value || '';

  // 定时触发类型不响应普通消息，仅由定时任务系统调用
  if (type === 'scheduled' || type === 'timer') return null;
  // 定时任务系统发送的特殊消息标记
  if (content === '__scheduled_trigger__' || content === '__scheduled__') return [];
  if (!val) return null;

  switch (type) {
    case 'exact': return content === val ? [] : null;
    case 'contains': return content.includes(val) ? [] : null;
    case 'startswith': return content.startsWith(val) ? [] : null;
    case 'regex': try { const m = content.match(new RegExp(val)); return m ? Array.from(m).slice(1) : null; } catch { return null; }
    case 'any': return val.split('|').map(k => k.trim()).filter(Boolean).some(kw => content.includes(kw)) ? [] : null;
    default: return null;
  }
}

// 检查条件
function checkCondition (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext): boolean {
  const type = (data.condition_type || 'contains') as string;
  const val = replaceVars((data.condition_value || '') as string, event, content, ctx);
  const varName = (data.var_name || '') as string;
  const uid = event.user_id;
  const dayMap: Record<string, number> = { '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 0 };

  switch (type) {
    case 'contains': return content.includes(val);
    case 'equals': return content === val;
    case 'regex': try { return new RegExp(val).test(content); } catch { return false; }
    case 'random': return Math.random() * 100 < parseFloat(val);
    case 'user_id': return uid === val;
    case 'group_id': return event.group_id === val;
    case 'var_equals': return String(ctx[varName]) === val;
    case 'var_gt': return Number(ctx[varName] || 0) > Number(val);
    case 'var_lt': return Number(ctx[varName] || 0) < Number(val);
    case 'data_equals': { const [k, v] = val.split('='); return String(storage.getUserValue(uid, k?.trim() || '', '')) === v?.trim(); }
    case 'data_gt': { const [k, v] = val.split('>'); return Number(storage.getUserValue(uid, k?.trim() || '', 0)) > Number(v?.trim()); }
    case 'data_lt': { const [k, v] = val.split('<'); return Number(storage.getUserValue(uid, k?.trim() || '', 0)) < Number(v?.trim()); }
    case 'data_is_today': return String(storage.getUserValue(uid, val, '')) === new Date().toISOString().split('T')[0];
    case 'cooldown': { const [k, s] = val.split(','); return (Date.now() / 1000 - Number(storage.getUserValue(uid, k?.trim() || '', 0))) >= Number(s?.trim() || 0); }
    case 'time_range': { const [s, e] = val.split('-').map(x => parseInt(x.trim())), h = new Date().getHours(); return s <= e ? (h >= s && h <= e) : (h >= s || h <= e); }
    case 'weekday_in': { const days = val.split('|').map(d => d.trim()); return days.some(d => (dayMap[d] ?? parseInt(d)) === new Date().getDay()); }
    case 'global_equals': { const [k, v] = val.split('='); return String(storage.getGlobalValue(k?.trim() || '', '')) === v?.trim(); }
    case 'global_gt': { const [k, v] = val.split('>'); return Number(storage.getGlobalValue(k?.trim() || '', 0)) > Number(v?.trim()); }
    case 'expression': try { return Boolean(eval(replaceVars(val, event, content, ctx).replace(/==/g, '===').replace(/!=/g, '!=='))); } catch { return false; }
    default: return true;
  }
}

// 执行存储操作
function execStorage (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext): void {
  const type = (data.storage_type || 'get') as string;
  const key = replaceVars((data.storage_key || '') as string, event, content, ctx);
  const val = replaceVars((data.storage_value || '') as string, event, content, ctx);
  const res = (data.result_var || 'data_result') as string, uid = event.user_id, def = Number(data.default_value ?? 0);
  if (!key) return;
  switch (type) {
    case 'get': ctx[res] = storage.getUserValue(uid, key, data.default_value ?? 0); break;
    case 'set': storage.setUserValue(uid, key, parseValue(val)); ctx[res] = val; break;
    case 'incr': ctx[res] = storage.incrUserValue(uid, key, Number(val) || 1, def); break;
    case 'decr': ctx[res] = storage.incrUserValue(uid, key, -(Number(val) || 1), def); break;
    case 'delete': storage.deleteUserValue(uid, key); ctx[res] = ''; break;
  }
}

// 执行全局存储
function execGlobalStorage (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext): void {
  const type = (data.storage_type || 'get') as string;
  const key = replaceVars((data.storage_key || '') as string, event, content, ctx);
  const val = replaceVars((data.storage_value || '') as string, event, content, ctx);
  const res = (data.result_var || 'global_result') as string, def = Number(data.default_value ?? 0);
  if (!key) return;
  switch (type) {
    case 'get': ctx[res] = storage.getGlobalValue(key, data.default_value ?? 0); break;
    case 'set': storage.setGlobalValue(key, parseValue(val)); ctx[res] = val; break;
    case 'incr': ctx[res] = storage.incrGlobalValue(key, Number(val) || 1, def); break;
    case 'decr': ctx[res] = storage.incrGlobalValue(key, -(Number(val) || 1), def); break;
  }
}

// 执行排行榜
function execLeaderboard (data: Record<string, unknown>, event: MessageEvent, ctx: ExecutionContext): void {
  const type = (data.leaderboard_type || 'top') as string, key = (data.leaderboard_key || 'score') as string;
  const limit = Number(data.limit || 10), asc = data.ascending === 'true' || data.ascending === true;
  switch (type) {
    case 'top': { const r = storage.getLeaderboard(key, limit, asc); ctx.leaderboard = r.map(([u, v], i) => `${i + 1}. ${u.slice(0, 8)}... : ${Number.isInteger(v) ? v : v.toFixed(2)}`).join('\n'); ctx.leaderboard_list = r; break; }
    case 'my_rank': { const { rank, value, total } = storage.getUserRank(event.user_id, key, asc); ctx.my_rank = rank; ctx.my_value = value; ctx.total_users = total; break; }
    case 'count': ctx.user_count = storage.countUsersWithKey(key); break;
  }
}

// 执行数学运算
function execMath (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext): void {
  const type = (data.math_type || 'add') as string;
  const a = Number(replaceVars((data.operand1 || '0') as string, event, content, ctx));
  const b = Number(replaceVars((data.operand2 || '0') as string, event, content, ctx));
  const ops: Record<string, (x: number, y: number) => number> = {
    add: (x, y) => x + y, sub: (x, y) => x - y, mul: (x, y) => x * y, div: (x, y) => y ? x / y : 0,
    mod: (x, y) => y ? x % y : 0, pow: Math.pow, min: Math.min, max: Math.max, random: (x, y) => Math.floor(Math.random() * (y - x + 1)) + x
  };
  const r = (ops[type] || (() => a))(a, b);
  ctx[(data.result_var || 'math_result') as string] = Number.isInteger(r) ? r : parseFloat(r.toFixed(2));
}

// 执行字符串操作
function execString (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext): void {
  const type = (data.string_type || 'concat') as string;
  const s1 = replaceVars((data.input1 || '') as string, event, content, ctx);
  const s2 = replaceVars((data.input2 || '') as string, event, content, ctx);
  const res = (data.result_var || 'string_result') as string;
  let r: string | number = s1;
  switch (type) {
    case 'concat': r = s1 + s2; break;
    case 'replace': r = s1.replace(new RegExp(data.target as string || '', 'g'), s2); break;
    case 'split': { const p = s1.split(s2 || '|'); ctx.split_list = p; ctx.split_count = p.length; r = p[0] || ''; break; }
    case 'substr': { const [a, b] = (s2 || '0').split(',').map(x => parseInt(x.trim())); r = b ? s1.slice(a, b) : s1.slice(a); break; }
    case 'length': r = s1.length; break;
    case 'upper': r = s1.toUpperCase(); break;
    case 'lower': r = s1.toLowerCase(); break;
    case 'trim': r = s1.trim(); break;
    case 'contains': r = s1.includes(s2) ? '1' : '0'; ctx.contains = s1.includes(s2); break;
    case 'repeat': r = s1.repeat(Math.min(parseInt(s2) || 1, 100)); break;
  }
  ctx[res] = r;
}

// 执行随机抽取
function execListRandom (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext): void {
  const items = replaceVars((data.list_items || '') as string, event, content, ctx).split('|').map(s => s.trim()).filter(Boolean);
  const resVar = (data.result_var || 'list_result') as string, idxVar = (data.index_var || 'list_index') as string;
  if (!items.length) { ctx[resVar] = ''; ctx[idxVar] = -1; return; }

  const wStr = (data.weights || '') as string;
  if (wStr) {
    const w = wStr.split('|').map(x => parseFloat(x.trim()));
    if (w.length === items.length) {
      const total = w.reduce((a, b) => a + b, 0); let r = Math.random() * total, c = 0;
      for (let i = 0; i < w.length; i++) { c += w[i]; if (r <= c) { ctx[resVar] = items[i]; ctx[idxVar] = i; return; } }
    }
  }
  const i = Math.floor(Math.random() * items.length); ctx[resVar] = items[i]; ctx[idxVar] = i;
}

// 执行动作
async function execAction (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext, reply: ReplyFunctions): Promise<void> {
  const type = (data.action_type || 'reply_text') as string;
  const val = replaceVars((data.action_value || '') as string, event, content, ctx);
  const rv = (k: string, d = '') => replaceVars((data[k] || d) as string, event, content, ctx);
  const toBool = (k: string) => data[k] === true || data[k] === 'true';

  switch (type) {
    case 'reply_text': { const r = val.split('|||').map(s => s.trim()).filter(Boolean); await reply.reply(r.length ? r[Math.floor(Math.random() * r.length)] : val); break; }
    case 'reply_image': await reply.replyImage(val, rv('image_text') || undefined); break;
    case 'reply_voice': await reply.replyVoice(val); break;
    case 'reply_video': await reply.replyVideo(val); break;
    case 'reply_at': await reply.replyAt(val); break;
    case 'reply_face': await reply.replyFace(parseInt(val) || 0); break;
    case 'reply_poke': await reply.replyPoke(val || event.user_id); break;
    case 'reply_json': try { await reply.replyJson(JSON.parse(val)); } catch { await reply.reply(val); } break;
    case 'reply_file': await reply.replyFile(val, rv('file_name') || undefined); break;
    case 'reply_music': await reply.replyMusic((data.music_type || 'qq') as string, val); break;
    case 'reply_forward': await reply.replyForward(val.split('|||').map(s => s.trim()).filter(Boolean)); break;
    case 'custom_api': await execCustomApi(data, event, content, ctx, reply); break;
    case 'math': execMath(data, event, content, ctx); break;
    case 'string_op': execString(data, event, content, ctx); break;
    case 'group_sign': await reply.groupSign().catch(() => { }); break;
    case 'group_ban': await reply.groupBan(rv('target_user', '{user_id}'), parseInt(rv('ban_duration', '600')) || 600).catch(() => { }); break;
    case 'group_kick': await reply.groupKick(rv('target_user', '{user_id}'), toBool('reject_add')).catch(() => { }); break;
    case 'group_whole_ban': await reply.groupWholeBan(toBool('enable_ban')).catch(() => { }); break;
    case 'group_set_card': await reply.groupSetCard(rv('target_user', '{user_id}'), rv('card_value')).catch(() => { }); break;
    case 'group_set_admin': await reply.groupSetAdmin(rv('target_user', '{user_id}'), toBool('enable_admin')).catch(() => { }); break;
    case 'group_notice': await reply.groupNotice(val).catch(() => { }); break;
    case 'recall_msg': await reply.recallMsg(rv('message_id', '{message_id}')).catch(() => { }); break;
    case 'call_api': { let p: Record<string, unknown> = {}; try { p = JSON.parse(rv('api_params', '{}')); } catch { } const r = await reply.callApi(rv('api_action'), p).catch(() => null); if (data.result_var) ctx[data.result_var as string] = r; break; }
  }
}

// 执行自定义API
async function execCustomApi (data: Record<string, unknown>, event: MessageEvent, content: string, ctx: ExecutionContext, reply: ReplyFunctions): Promise<void> {
  const url = replaceVars((data.api_url || '') as string, event, content, ctx);
  const method = ((data.api_method || 'GET') as string).toUpperCase();
  const hdrs: Record<string, string> = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', 'Content-Type': 'application/json' };
  const hdrStr = (data.api_headers || '') as string;
  if (hdrStr) try { Object.assign(hdrs, JSON.parse(hdrStr)); } catch { hdrStr.split('\n').forEach(l => { const [k, v] = l.split(':'); if (k && v) hdrs[k.trim()] = replaceVars(v.trim(), event, content, ctx); }); }
  const bodyStr = (data.api_body || '') as string;
  
  // 构建请求体，自动添加 bot_id 和 user_id
  let body: string | undefined;
  if (bodyStr && ['POST', 'PUT', 'PATCH'].includes(method)) {
    const bodyContent = replaceVars(bodyStr, event, content, ctx);
    try {
      const bodyJson = JSON.parse(bodyContent);
      const meta = pluginState.getRequestMeta();
      if (meta.bot_id) { bodyJson.bot_id = meta.bot_id; bodyJson.user_id = meta.user_id; }
      body = JSON.stringify(bodyJson);
    } catch { body = bodyContent; }
  }

  try {
    const r = await fetch(url, { method, headers: hdrs, body, signal: AbortSignal.timeout(Number(data.api_timeout || 10) * 1000) });
    ctx.api_status = r.status;
    const resType = (data.response_type || 'json') as string;

    if (resType === 'json') try { ctx.api_json = await r.json(); ctx.api_response = JSON.stringify(ctx.api_json); } catch { ctx.api_response = await r.text(); }
    else if (resType === 'binary') { ctx.api_binary = Buffer.from(await r.arrayBuffer()); ctx.api_response = url; }
    else ctx.api_response = await r.text();

    const rType = (data.reply_type || 'text') as string, tpl = (data.api_reply || '') as string;
    const text = tpl ? processTemplate(tpl, event, content, ctx) : String(ctx.api_response);
    const bin = resType === 'binary' && ctx.api_binary ? ctx.api_binary as Buffer : text;

    switch (rType) {
      case 'image': await reply.replyImage(bin, replaceVars((data.image_text || '') as string, event, content, ctx) || undefined); break;
      case 'voice': await reply.replyVoice(bin); break;
      case 'video': await reply.replyVideo(bin); break;
      case 'forward': await reply.replyForward(text.split('|||').map(s => s.trim()).filter(Boolean)); break;
      default: await reply.reply(text);
    }
  } catch (e: any) { await reply.reply(`API失败: ${e.message || '超时'}`); }
}

// 处理模板
function processTemplate (tpl: string, event: MessageEvent, content: string, ctx: ExecutionContext): string {
  let r = replaceVars(tpl, event, content, ctx);
  const json = ctx.api_json as Record<string, unknown> | undefined;
  if (json) r = r.replace(/\{([^}]+)\}/g, (m, p) => ['user_id', 'group_id', 'content', 'message', 'api_response', 'api_status'].includes(p) || p.startsWith('$') ? m : String(extractPath(json, p.trim())));
  return r;
}

// 提取JSON路径
function extractPath (data: Record<string, unknown>, path: string): unknown {
  try {
    let r: unknown = data;
    for (const p of path.split('.')) { const m = p.match(/^([^[]+)(?:\[(\d+)\])?$/); if (!m) return ''; if (m[1]) r = (r as Record<string, unknown>)?.[m[1]]; if (m[2] !== undefined) r = (r as unknown[])?.[parseInt(m[2])]; }
    return r ?? '';
  } catch { return ''; }
}

// 替换变量
function replaceVars (text: string, event: MessageEvent, content: string, ctx: ExecutionContext): string {
  if (!text || !text.includes('{')) return text;
  const n = new Date(), d = n.toISOString().split('T')[0];
  const vars: Record<string, string> = {
    '{user_id}': event.user_id, '{group_id}': event.group_id || '', '{message_id}': String(event.message_id || ''), '{content}': content, '{message}': content,
    '{date}': d, '{today}': d, '{time}': n.toTimeString().split(' ')[0], '{datetime}': n.toISOString().replace('T', ' ').split('.')[0],
    '{timestamp}': String(Math.floor(Date.now() / 1000)), '{year}': String(n.getFullYear()), '{month}': String(n.getMonth() + 1),
    '{day}': String(n.getDate()), '{hour}': String(n.getHours()), '{minute}': String(n.getMinutes()), '{weekday}': String(n.getDay()),
    '{weekday_cn}': ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][n.getDay()],
    '{random}': String(Math.floor(Math.random() * 100) + 1), '{random100}': String(Math.floor(Math.random() * 100) + 1),
    '{random10}': String(Math.floor(Math.random() * 10) + 1), '{random6}': String(Math.floor(Math.random() * 6) + 1),
    '{at_user}': `[CQ:at,qq=${event.user_id}]`,
  };
  for (const [k, v] of Object.entries(vars)) text = text.replace(new RegExp(k.replace(/[{}]/g, '\\$&'), 'g'), v);
  ctx.regex_groups?.forEach((g, i) => { text = text.replace(new RegExp(`\\{\\$${i + 1}\\}`, 'g'), g || ''); });
  for (const [k, v] of Object.entries(ctx)) if (k !== 'regex_groups' && k !== 'api_binary') text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v ?? ''));
  return text.replace(/\{storage\.([^}]+)\}/g, (_, k) => String(storage.getUserValue(event.user_id, k, '')));
}

// 解析值
function parseValue (v: string): unknown {
  if (/^-?\d+$/.test(v)) return parseInt(v);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

// 规范化连接格式
function normalizeConns (wf: Workflow): WorkflowConnection[] {
  return (wf.connections || []).map(c => {
    let out = (c as any).from_output || (c as any).port || 'output_1';
    if (out === 'output') out = 'output_1';
    else if (out === 'output-1') out = 'output_1';
    else if (out === 'output-2') out = 'output_2';
    return { from_node: (c as any).from_node || (c as any).from, to_node: (c as any).to_node || (c as any).to, from_output: out };
  });
}

// 从节点执行
async function runNode (id: string, nodes: Map<string, WorkflowNode>, conns: WorkflowConnection[], event: MessageEvent, content: string, ctx: ExecutionContext, reply: ReplyFunctions): Promise<boolean> {
  const node = nodes.get(id);
  if (!node) return false;
  const { type, data } = node;
  let ok = true;

  pluginState.log('debug', `执行: ${id} (${type})`);

  try {
    switch (type) {
      case 'condition': ok = checkCondition(data, event, content, ctx); break;
      case 'action': await execAction(data, event, content, ctx, reply); break;
      case 'delay': await new Promise(r => setTimeout(r, Math.min(Number(data.seconds || 1), 10) * 1000)); break;
      case 'set_var': { const k = (data.var_name || '') as string; if (k) ctx[k] = replaceVars((data.var_value || '') as string, event, content, ctx); break; }
      case 'storage': execStorage(data, event, content, ctx); break;
      case 'global_storage': execGlobalStorage(data, event, content, ctx); break;
      case 'leaderboard': execLeaderboard(data, event, ctx); break;
      case 'list_random': execListRandom(data, event, content, ctx); break;
    }
  } catch (e) { pluginState.log('error', `节点失败 ${id}:`, e); }

  const out1 = ['output_1', 'output-1', 'output'], out2 = ['output_2', 'output-2'];
  const next = ok ? conns.filter(c => c.from_node === id && out1.includes(c.from_output || 'output_1')) : conns.filter(c => c.from_node === id && out2.includes(c.from_output));
  for (const c of next) await runNode(c.to_node, nodes, conns, event, content, ctx, reply);
  return true;
}

// 执行工作流
export async function execute (wf: Workflow, event: MessageEvent, content: string, reply: ReplyFunctions): Promise<boolean> {
  const nodes = new Map<string, WorkflowNode>((wf.nodes || []).map(n => [n.id, n]));
  const conns = normalizeConns(wf);
  const triggers = Array.from(nodes.values()).filter(n => n.type === 'trigger');

  for (const t of triggers) {
    const g = checkTrigger(t, content);
    if (g !== null) { pluginState.log('debug', `触发器匹配: ${t.id}`); return await runNode(t.id, nodes, conns, event, content, { regex_groups: g }, reply); }
  }
  return false;
}

// 从触发器执行（定时任务）
export async function executeFromTrigger (wf: Workflow, event: MessageEvent, reply: ReplyFunctions): Promise<boolean> {
  const nodes = new Map<string, WorkflowNode>((wf.nodes || []).map(n => [n.id, n]));
  const conns = normalizeConns(wf);
  const triggers = Array.from(nodes.values()).filter(n => n.type === 'trigger');
  if (!triggers.length) return false;

  const ctx: ExecutionContext = { regex_groups: [] };
  let done = false;
  const out1 = ['output_1', 'output-1', 'output'];

  for (const t of triggers) {
    for (const c of conns.filter(x => x.from_node === t.id && out1.includes(x.from_output || 'output_1'))) {
      await runNode(c.to_node, nodes, conns, event, '', ctx, reply);
      done = true;
    }
  }
  return done;
}
