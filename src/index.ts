// 可视化工作流插件
import type { PluginModule, NapCatPluginContext, PluginConfigSchema, PluginConfigUIController } from 'napcat-types/napcat-onebot/network/plugin-manger';
import type { OB11Message } from 'napcat-types/napcat-onebot/types/index';
import fs from 'fs';
import path from 'path';
import type { PluginConfig } from './types';
import { pluginState, DEFAULT_CONFIG } from './core/state';
import { handleMessage } from './handlers/message-handler';
import { registerApiRoutes } from './handlers/api-handler';
import { startScheduler, stopScheduler, setMessageSender } from './services/scheduler';
import { startWorkflowWatcher, stopWorkflowWatcher } from './services/storage';

export let plugin_config_ui: PluginConfigSchema = [];

// 初始化
const plugin_init: PluginModule['plugin_init'] = async (ctx: NapCatPluginContext) => {
  Object.assign(pluginState, {
    logger: ctx.logger, actions: ctx.actions, adapterName: ctx.adapterName,
    networkConfig: ctx.pluginManager.config, dataPath: ctx.dataPath, pluginPath: ctx.pluginPath
  });
  pluginState.log('info', '工作流插件初始化中...');

  // 配置UI
  plugin_config_ui = ctx.NapCatConfig.combine(
    ctx.NapCatConfig.html('<div style="padding:10px;background:linear-gradient(135deg,rgba(88,101,242,0.1),rgba(16,185,129,0.1));border-radius:8px"><b>🔧 可视化工作流</b><br/><span style="color:#666;font-size:13px">拖拽节点创建自动化流程 | 交流群：631348711</span></div>'),
    ctx.NapCatConfig.boolean('enableWorkflow', '启用工作流', true, '启用可视化工作流功能'),
    ctx.NapCatConfig.boolean('debug', '调试模式', false, '显示详细调试日志')
  );

  // 加载配置
  if (fs.existsSync(ctx.configPath)) {
    try { pluginState.config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(ctx.configPath, 'utf-8')) }; } catch { }
  }

  // 确保数据目录存在
  if (!fs.existsSync(ctx.dataPath)) fs.mkdirSync(ctx.dataPath, { recursive: true });

  // 注册路由和页面
  registerApiRoutes(ctx.router);
  ctx.router.static('/static', 'webui');
  ctx.router.page({ path: 'workflow', title: '工作流编辑器', icon: '🔧', htmlFile: 'webui/workflow.html', description: '可视化工作流编辑器' });

  // 设置消息发送器
  const callAction = async (action: string, params: Record<string, unknown>) =>
    await ctx.actions.call(action, params as never, ctx.adapterName, ctx.pluginManager.config).catch(() => null);

  setMessageSender(
    async (type, id, messages) => {
      const action = type === 'group' ? 'send_group_msg' : 'send_private_msg';
      const params = type === 'group' ? { group_id: id, message: messages } : { user_id: id, message: messages };
      await callAction(action, params);
    },
    callAction
  );

  // 获取机器人QQ号
  try {
    const loginInfo = await ctx.actions.call('get_login_info', {}, ctx.adapterName, ctx.pluginManager.config) as { user_id?: number | string; } | undefined;
    pluginState.botId = loginInfo?.user_id ? String(loginInfo.user_id) : '';
  } catch { /* ignore */ }

  // 启动服务
  startWorkflowWatcher();
  startScheduler();
  pluginState.initialized = true;
  pluginState.log('info', `工作流插件初始化完成${pluginState.botId ? ` (Bot: ${pluginState.botId})` : ''}`);
};

// 配置读写
export const plugin_get_config = async (): Promise<PluginConfig> => pluginState.config;
export const plugin_set_config = async (ctx: NapCatPluginContext, config: PluginConfig): Promise<void> => {
  pluginState.config = config;
  if (ctx?.configPath) {
    const dir = path.dirname(ctx.configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ctx.configPath, JSON.stringify(config, null, 2), 'utf-8');
  }
};

// 配置控制器
const plugin_config_controller = (): (() => void) | void => () => { };
const plugin_on_config_change = (): void => { };

// 清理和消息处理
const plugin_cleanup: PluginModule['plugin_cleanup'] = async () => { stopWorkflowWatcher(); stopScheduler(); };
const plugin_onmessage: PluginModule['plugin_onmessage'] = async (ctx, event: OB11Message) => {
  if (event.post_type === 'message' && pluginState.config.enableWorkflow) await handleMessage(event, ctx);
};

export { plugin_init, plugin_onmessage, plugin_cleanup, plugin_config_controller, plugin_on_config_change };
