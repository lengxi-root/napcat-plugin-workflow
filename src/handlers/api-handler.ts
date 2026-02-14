// 工作流 API 处理器
import type { PluginHttpRequest, PluginHttpResponse, PluginRouterRegistry } from 'napcat-types/napcat-onebot/network/plugin-manger';
import type { Workflow, ScheduledTask } from '../types';
import { MASTER_ONLY_TRIGGERS } from '../types';
import { pluginState } from '../core/state';
import * as storage from '../services/storage';
import * as scheduler from '../services/scheduler';

// 生成唯一ID
const genId = () => 'wf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// 主人权限验证
function checkAuth (req: PluginHttpRequest, res: PluginHttpResponse): boolean {
  if (!pluginState.requireMasterAuth()) return true;
  const pwd = (req.body as any)?.master_password || req.query?.master_password;
  if (!pluginState.verifyMaster(pwd)) { res.json({ success: false, error: '需要主人权限', need_auth: true }); return false; }
  return true;
}

// 检查工作流是否需要主人权限
function needsMaster (wf: Partial<Workflow>): boolean {
  if (MASTER_ONLY_TRIGGERS.includes(wf.trigger_type || '')) return true;
  return (wf.nodes || []).some(n => n.type === 'trigger' && MASTER_ONLY_TRIGGERS.includes(String(n.data?.trigger_type || '')));
}

// 注册API路由（使用NoAuth方法注册到 /plugin/{pluginId}/api/ 路径）
export function registerApiRoutes (router: PluginRouterRegistry): void {
  // 配置和验证
  router.getNoAuth('/config', (_, res) => res.json({ success: true, require_master: pluginState.requireMasterAuth(), master_only_triggers: MASTER_ONLY_TRIGGERS }));
  router.postNoAuth('/verify_master', (req, res) => {
    const { password } = req.body as { password?: string; };
    res.json(pluginState.verifyMaster(password || '') ? { success: true, message: '验证成功' } : { success: false, error: '密码错误' });
  });

  // 工作流CRUD
  router.getNoAuth('/list', (_, res) => res.json({ success: true, workflows: storage.loadWorkflows() }));

  router.postNoAuth('/save', (req, res) => {
    try {
      const data = req.body as Partial<Workflow> & { master_password?: string; };
      pluginState.log('debug', '保存请求:', JSON.stringify(data).slice(0, 300));
      if (needsMaster(data) && !checkAuth(req, res)) return;
      if (!data.nodes) { res.json({ success: false, error: '缺少节点' }); return; }
      const nodes = Array.isArray(data.nodes) ? data.nodes : Object.values(data.nodes);
      if (!nodes.length) { res.json({ success: false, error: '节点为空' }); return; }

      const workflows = storage.loadWorkflows();
      const existing = data.id ? workflows.findIndex(w => w.id === data.id) : -1;
      const base = existing >= 0 ? workflows[existing] : { id: genId(), name: '未命名', trigger_type: 'exact', trigger_content: '', enabled: true, stop_propagation: false };

      const wf: Workflow = {
        id: data.id || base.id, name: data.name || base.name, trigger_type: data.trigger_type || base.trigger_type,
        trigger_content: data.trigger_content ?? base.trigger_content, enabled: data.enabled ?? base.enabled,
        stop_propagation: data.stop_propagation || false, nodes, connections: data.connections || []
      };

      if (existing >= 0) workflows[existing] = wf; else workflows.push(wf);
      if (!storage.saveWorkflows(workflows)) { res.json({ success: false, error: '保存失败' }); return; }
      pluginState.log('info', `工作流 [${wf.name}] 已保存`);
      res.json({ success: true, data: { id: wf.id } });
    } catch (e: any) { pluginState.log('error', '保存失败:', e); res.json({ success: false, error: e.message || '保存失败' }); }
  });

  router.postNoAuth('/delete', (req, res) => {
    const { id } = req.body as { id?: string; };
    res.json(id ? { success: storage.deleteWorkflow(id), message: '已删除' } : { success: false, error: '缺少ID' });
  });

  router.postNoAuth('/toggle', (req, res) => {
    const { id } = req.body as { id?: string; };
    res.json(id ? { success: storage.toggleWorkflow(id), message: '状态已更新' } : { success: false, error: '缺少ID' });
  });

  // 测试API
  router.postNoAuth('/test_api', async (req, res) => {
    try {
      const { url, method = 'GET', headers = {}, body } = req.body as { url?: string; method?: string; headers?: Record<string, string>; body?: string; };
      if (!url) { res.json({ success: false, error: '缺少URL' }); return; }

      const hdrs: Record<string, string> = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
      if (typeof headers === 'string') try { Object.assign(hdrs, JSON.parse(headers)); } catch { }
      else if (headers) Object.assign(hdrs, headers);

      const r = await fetch(url, { method: method.toUpperCase(), headers: hdrs, body: ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) ? body : undefined, signal: AbortSignal.timeout(10000) });
      const ct = r.headers.get('content-type') || '';

      if (ct.includes('image') || ct.includes('audio') || ct.includes('video')) res.json({ success: true, status_code: r.status, is_binary: true, response: '[二进制]' });
      else if (ct.includes('application/json')) { const json = await r.json(); res.json({ success: true, status_code: r.status, is_json: true, json_data: json, response: JSON.stringify(json) }); }
      else res.json({ success: true, status_code: r.status, response: (await r.text()).slice(0, 5000) });
    } catch (e: any) { res.json({ success: false, error: e.message || '请求失败' }); }
  });

  // AI配置 - 返回当前 AI API 配置给前端
  router.getNoAuth('/ai_config', (_, res) => {
    const ai = pluginState.getAiConfig();
    res.json({ success: true, url: ai.url, useYtea: ai.useYtea });
  });

  // AI辅助 - 返回可用模型列表（实时从 API 获取）
  router.getNoAuth('/ai_models', async (_, res) => {
    const ai = pluginState.getAiConfig();
    const defaultModels = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.1', 'gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-4-turbo', 'claude-3-5-sonnet', 'claude-3-5-haiku', 'deepseek-chat', 'deepseek-reasoner', 'gemini-2.5-flash', 'gemini-2.5-pro'];
    const modelsUrl = ai.useYtea ? 'https://api.ytea.top/v1/models' : 'https://i.elaina.vin/api/openai/models';
    try {
      const headers: Record<string, string> = {};
      if (ai.useYtea && ai.key) headers['Authorization'] = `Bearer ${ai.key}`;
      const r = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const data = await r.json() as Record<string, unknown>;
        // api.ytea.top 返回 OpenAI 标准格式 {data: [{id: "model-name"}, ...]}
        if (ai.useYtea && Array.isArray(data.data)) {
          const models = (data.data as Array<{ id: string; }>).map(m => m.id).filter(Boolean);
          if (models.length) { res.json({ success: true, models, auto_switch: false }); return; }
        }
        // i.elaina.vin 返回 {success: true, chat: [...]}
        if (!ai.useYtea && (data as any).success && Array.isArray((data as any).chat) && (data as any).chat.length) {
          res.json({ success: true, models: (data as any).chat, auto_switch: true }); return;
        }
      }
    } catch { /* 获取失败使用默认列表 */ }
    res.json({ success: true, models: defaultModels, auto_switch: !ai.useYtea });
  });

  // AI 聊天代理 - 前端通过后端代理 AI 请求（密钥存在后端）
  router.postNoAuth('/ai_chat', async (req, res) => {
    try {
      const { model, messages } = req.body as { model?: string; messages?: unknown[]; };
      if (!messages?.length) { res.json({ success: false, error: '缺少消息' }); return; }
      const ai = pluginState.getAiConfig();
      const meta = pluginState.getRequestMeta();
      const body: Record<string, unknown> = { model: model || 'gpt-5', messages };
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ai.useYtea) {
        headers['Authorization'] = `Bearer ${ai.key}`;
      } else {
        Object.assign(body, { type: 100, secret_key: '2218872014', bot_id: meta.bot_id || 'webui', user_id: meta.user_id || 'webui' });
      }
      const r = await fetch(ai.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const data = await r.json();
      res.json(data);
    } catch (e: any) { res.json({ choices: [{ message: { role: 'assistant', content: `AI请求失败: ${e.message || '超时'}` } }] }); }
  });

  router.postNoAuth('/ai_generate', (req, res) => {
    const { description } = req.body as { description?: string; };
    if (!description) { res.json({ success: false, error: '请输入描述' }); return; }
    const keyword = description.split(' ')[0] || '触发';
    res.json({
      success: true, workflow: {
        nodes: [
          { id: 'node_1', type: 'trigger', x: 100, y: 100, data: { trigger_type: 'startswith', trigger_content: keyword } },
          { id: 'node_2', type: 'action', x: 400, y: 100, data: { action_type: 'reply_text', action_value: '收到: {content}' } }
        ],
        connections: [{ from_node: 'node_1', from_output: 'output_1', to_node: 'node_2' }]
      }
    });
  });

  router.postNoAuth('/ai_node', (req, res) => {
    const { node_type, description } = req.body as { node_type?: string; description?: string; };
    if (!node_type || !description) { res.json({ success: false, error: '参数不完整' }); return; }
    const dataMap: Record<string, Record<string, unknown>> = {
      trigger: { trigger_type: 'startswith', trigger_content: description.split(' ')[0] || '触发' },
      condition: { condition_type: 'contains', condition_value: description },
      action: { action_type: 'reply_text', action_value: description },
      storage: { storage_type: 'incr', storage_key: 'score', storage_value: '1' }
    };
    res.json({ success: true, node_data: dataMap[node_type] || {} });
  });

  // 定时任务API
  router.getNoAuth('/scheduled/list', (_, res) => res.json({ success: true, tasks: scheduler.getAllScheduledTasks() }));

  router.postNoAuth('/scheduled/add', (req, res) => {
    if (!checkAuth(req, res)) return;
    const d = req.body as Partial<ScheduledTask> & { master_password?: string; };
    if (!d.id || !d.workflow_id || !d.target_id || !d.target_type || !d.task_type) { res.json({ success: false, error: '缺少参数' }); return; }
    res.json(scheduler.addScheduledTask({ id: d.id, workflow_id: d.workflow_id, task_type: d.task_type, daily_time: d.daily_time, interval_seconds: d.interval_seconds, weekdays: d.weekdays, target_type: d.target_type, target_id: d.target_id, trigger_user_id: d.trigger_user_id, enabled: d.enabled !== false, description: d.description }));
  });

  router.postNoAuth('/scheduled/delete', (req, res) => { if (!checkAuth(req, res)) return; const { id } = req.body as { id?: string; }; res.json(id ? scheduler.removeScheduledTask(id) : { success: false, error: '缺少ID' }); });
  router.postNoAuth('/scheduled/toggle', (req, res) => { if (!checkAuth(req, res)) return; const { id } = req.body as { id?: string; }; res.json(id ? scheduler.toggleScheduledTask(id) : { success: false, error: '缺少ID' }); });
  router.postNoAuth('/scheduled/run', async (req, res) => { if (!checkAuth(req, res)) return; const { id } = req.body as { id?: string; }; res.json(id ? await scheduler.runScheduledTaskNow(id) : { success: false, error: '缺少ID' }); });

}
