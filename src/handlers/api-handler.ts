// 工作流 API 处理器
import type { PluginHttpRequest, PluginHttpResponse, PluginRouterRegistry } from 'napcat-types/napcat-onebot/network/plugin-manger';
import type { Workflow, ScheduledTask } from '../types';
import { MASTER_ONLY_TRIGGERS } from '../types';
import { pluginState } from '../core/state';
import * as storage from '../services/storage';
import * as scheduler from '../services/scheduler';

// 生成唯一ID
function generateId (): string {
  return 'wf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 检查主人权限
function checkMasterAuth (req: PluginHttpRequest, res: PluginHttpResponse): boolean {
  if (!pluginState.requireMasterAuth()) return true;
  const password = (req.body as any)?.master_password || req.query?.master_password;
  if (!pluginState.verifyMaster(password)) {
    res.json({ success: false, error: '需要主人权限，请验证密码', need_auth: true });
    return false;
  }
  return true;
}

// 检查工作流是否需要主人权限
function workflowNeedsMaster (workflow: Partial<Workflow>): boolean {
  const triggerType = workflow.trigger_type || '';
  if (MASTER_ONLY_TRIGGERS.includes(triggerType)) return true;
  // 检查节点中的触发器类型
  const nodes = workflow.nodes || [];
  return nodes.some(n => n.type === 'trigger' && MASTER_ONLY_TRIGGERS.includes(String(n.data?.trigger_type || '')));
}

// 注册所有 API 路由
export function registerApiRoutes (router: PluginRouterRegistry): void {
  // 获取配置（是否需要主人验证）
  router.get('/config', (_req: PluginHttpRequest, res: PluginHttpResponse) => {
    res.json({
      success: true,
      require_master: pluginState.requireMasterAuth(),
      master_only_triggers: MASTER_ONLY_TRIGGERS,
    });
  });

  // 验证主人密码
  router.post('/verify_master', (req: PluginHttpRequest, res: PluginHttpResponse) => {
    const { password } = req.body as { password?: string; };
    if (pluginState.verifyMaster(password || '')) {
      res.json({ success: true, message: '验证成功' });
    } else {
      res.json({ success: false, error: '密码错误' });
    }
  });

  // 获取工作流列表
  router.get('/list', (_req: PluginHttpRequest, res: PluginHttpResponse) => {
    const workflows = storage.loadWorkflows();
    res.json({ success: true, workflows });
  });

  // 保存工作流
  router.post('/save', (req: PluginHttpRequest, res: PluginHttpResponse) => {
    try {
      const data = req.body as Partial<Workflow> & { master_password?: string; };
      pluginState.log('debug', '收到保存请求:', JSON.stringify(data).slice(0, 300));

      // 检查是否需要主人权限
      if (workflowNeedsMaster(data) && !checkMasterAuth(req, res)) return;

      if (!data.nodes) { res.json({ success: false, error: '缺少节点数据' }); return; }
      const nodes = Array.isArray(data.nodes) ? data.nodes : Object.values(data.nodes);
      if (!nodes.length) { res.json({ success: false, error: '节点列表为空' }); return; }

      const workflows = storage.loadWorkflows();
      let workflow: Workflow;

      if (data.id && data.id !== '') {
        const idx = workflows.findIndex(w => w.id === data.id);
        if (idx >= 0) {
          workflow = { ...workflows[idx], name: data.name || workflows[idx].name, trigger_type: data.trigger_type || workflows[idx].trigger_type, trigger_content: data.trigger_content ?? workflows[idx].trigger_content, enabled: data.enabled !== undefined ? data.enabled : workflows[idx].enabled, stop_propagation: data.stop_propagation || false, nodes, connections: data.connections || [] };
          workflows[idx] = workflow;
        } else {
          workflow = { id: data.id || generateId(), name: data.name || '未命名', trigger_type: data.trigger_type || 'exact', trigger_content: data.trigger_content || '', enabled: data.enabled !== false, stop_propagation: data.stop_propagation || false, nodes, connections: data.connections || [] };
          workflows.push(workflow);
        }
      } else {
        workflow = { id: generateId(), name: data.name || '未命名', trigger_type: data.trigger_type || 'exact', trigger_content: data.trigger_content || '', enabled: data.enabled !== false, stop_propagation: data.stop_propagation || false, nodes, connections: data.connections || [] };
        workflows.push(workflow);
      }

      if (!storage.saveWorkflows(workflows)) { res.json({ success: false, error: '保存文件失败' }); return; }
      pluginState.log('info', `工作流 [${workflow.name}] 已保存`);
      res.json({ success: true, data: { id: workflow.id } });
    } catch (e: any) {
      pluginState.log('error', '保存工作流失败:', e);
      res.json({ success: false, error: e.message || '保存失败' });
    }
  });

  // 删除工作流
  router.post('/delete', (req: PluginHttpRequest, res: PluginHttpResponse) => {
    const { id } = req.body as { id?: string; };
    if (!id) { res.json({ success: false, error: '缺少ID' }); return; }
    res.json({ success: storage.deleteWorkflow(id), message: '已删除' });
  });

  // 切换工作流状态
  router.post('/toggle', (req: PluginHttpRequest, res: PluginHttpResponse) => {
    const { id } = req.body as { id?: string; };
    if (!id) { res.json({ success: false, error: '缺少ID' }); return; }
    res.json({ success: storage.toggleWorkflow(id), message: '状态已更新' });
  });

  // 测试 API
  router.post('/test_api', async (req: PluginHttpRequest, res: PluginHttpResponse) => {
    try {
      const { url, method = 'GET', headers = {}, body } = req.body as { url?: string; method?: string; headers?: Record<string, string>; body?: string; };
      if (!url) { res.json({ success: false, error: '缺少URL' }); return; }

      const reqHeaders: Record<string, string> = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
      if (typeof headers === 'string') { try { Object.assign(reqHeaders, JSON.parse(headers)); } catch { } }
      else if (headers) Object.assign(reqHeaders, headers);

      const fetchRes = await fetch(url, { method: method.toUpperCase(), headers: reqHeaders, body: ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()) ? body : undefined, signal: AbortSignal.timeout(10000) });
      const contentType = fetchRes.headers.get('content-type') || '';

      if (contentType.includes('image') || contentType.includes('audio') || contentType.includes('video')) {
        res.json({ success: true, status_code: fetchRes.status, is_binary: true, response: '[二进制数据]' });
      } else if (contentType.includes('application/json')) {
        const json = await fetchRes.json();
        res.json({ success: true, status_code: fetchRes.status, is_json: true, json_data: json, response: JSON.stringify(json) });
      } else {
        res.json({ success: true, status_code: fetchRes.status, response: (await fetchRes.text()).slice(0, 5000) });
      }
    } catch (e: any) { res.json({ success: false, error: e.message || '请求失败' }); }
  });

  // AI模型列表
  router.get('/ai_models', (_req: PluginHttpRequest, res: PluginHttpResponse) => {
    res.json({ success: true, models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo', 'claude-3-haiku', 'deepseek-chat'] });
  });

  // AI 生成工作流
  router.post('/ai_generate', (req: PluginHttpRequest, res: PluginHttpResponse) => {
    const { description } = req.body as { description?: string; };
    if (!description) { res.json({ success: false, error: '请输入描述' }); return; }
    res.json({
      success: true,
      workflow: {
        nodes: [
          { id: 'node_1', type: 'trigger', x: 100, y: 100, data: { trigger_type: 'startswith', trigger_content: description.split(' ')[0] || '触发' } },
          { id: 'node_2', type: 'action', x: 400, y: 100, data: { action_type: 'reply_text', action_value: '收到: {content}' } }
        ],
        connections: [{ from_node: 'node_1', from_output: 'output_1', to_node: 'node_2' }]
      }
    });
  });

  // AI 填写节点
  router.post('/ai_node', (req: PluginHttpRequest, res: PluginHttpResponse) => {
    const { node_type, description } = req.body as { node_type?: string; description?: string; };
    if (!node_type || !description) { res.json({ success: false, error: '参数不完整' }); return; }
    const nodeData: Record<string, unknown> = {};
    if (node_type === 'trigger') { nodeData.trigger_type = 'startswith'; nodeData.trigger_content = description.split(' ')[0] || '触发'; }
    else if (node_type === 'condition') { nodeData.condition_type = 'contains'; nodeData.condition_value = description; }
    else if (node_type === 'action') { nodeData.action_type = 'reply_text'; nodeData.action_value = description; }
    else if (node_type === 'storage') { nodeData.storage_type = 'incr'; nodeData.storage_key = 'score'; nodeData.storage_value = '1'; }
    res.json({ success: true, node_data: nodeData });
  });

  // ==================== 定时任务 API（需要主人权限） ====================

  router.get('/scheduled/list', (req: PluginHttpRequest, res: PluginHttpResponse) => {
    res.json({ success: true, tasks: scheduler.getAllScheduledTasks() });
  });

  router.post('/scheduled/add', (req: PluginHttpRequest, res: PluginHttpResponse) => {
    if (!checkMasterAuth(req, res)) return;
    const data = req.body as Partial<ScheduledTask> & { master_password?: string; };
    if (!data.id || !data.workflow_id || !data.target_id || !data.target_type || !data.task_type) {
      res.json({ success: false, error: '缺少必要参数' }); return;
    }
    res.json(scheduler.addScheduledTask({ id: data.id, workflow_id: data.workflow_id, task_type: data.task_type, daily_time: data.daily_time, interval_seconds: data.interval_seconds, weekdays: data.weekdays, target_type: data.target_type, target_id: data.target_id, trigger_user_id: data.trigger_user_id, enabled: data.enabled !== false, description: data.description }));
  });

  router.post('/scheduled/delete', (req: PluginHttpRequest, res: PluginHttpResponse) => {
    if (!checkMasterAuth(req, res)) return;
    const { id } = req.body as { id?: string; };
    if (!id) { res.json({ success: false, error: '缺少ID' }); return; }
    res.json(scheduler.removeScheduledTask(id));
  });

  router.post('/scheduled/toggle', (req: PluginHttpRequest, res: PluginHttpResponse) => {
    if (!checkMasterAuth(req, res)) return;
    const { id } = req.body as { id?: string; };
    if (!id) { res.json({ success: false, error: '缺少ID' }); return; }
    res.json(scheduler.toggleScheduledTask(id));
  });

  router.post('/scheduled/run', async (req: PluginHttpRequest, res: PluginHttpResponse) => {
    if (!checkMasterAuth(req, res)) return;
    const { id } = req.body as { id?: string; };
    if (!id) { res.json({ success: false, error: '缺少ID' }); return; }
    res.json(await scheduler.runScheduledTaskNow(id));
  });
}
