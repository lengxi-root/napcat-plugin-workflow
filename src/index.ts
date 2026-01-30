// NapCat 可视化工作流插件 @author 冷曦 @version 1.0.0
import type { PluginModule, NapCatPluginContext, PluginConfigSchema, PluginConfigUIController } from 'napcat-types/napcat-onebot/network/plugin-manger';
import type { OB11Message } from 'napcat-types/napcat-onebot/types/index';
import { EventType } from 'napcat-types/napcat-onebot/event/index';
import fs from 'fs';
import path from 'path';
import type { PluginConfig } from './types';
import { pluginState, DEFAULT_CONFIG } from './core/state';
import { handleMessage } from './handlers/message-handler';
import { registerApiRoutes } from './handlers/api-handler';
import { startScheduler, stopScheduler, setMessageSender } from './services/scheduler';
import { startWorkflowWatcher, stopWorkflowWatcher } from './services/storage';

export let plugin_config_ui: PluginConfigSchema = [];

// 插件初始化
const plugin_init: PluginModule['plugin_init'] = async (ctx: NapCatPluginContext) => {
  pluginState.logger = ctx.logger;
  pluginState.actions = ctx.actions;
  pluginState.adapterName = ctx.adapterName;
  pluginState.networkConfig = ctx.pluginManager.config;
  pluginState.dataPath = ctx.dataPath;
  pluginState.log('info', '工作流插件正在初始化...');

  // 配置 UI
  plugin_config_ui = ctx.NapCatConfig.combine(
    ctx.NapCatConfig.html('<div style="padding:10px;background:linear-gradient(135deg,rgba(88,101,242,0.1),rgba(16,185,129,0.1));border-radius:8px"><h3>🔧 可视化工作流</h3><p>拖拽节点创建自动化流程</p><p style="margin-top:8px;color:#666;font-size:12px">💬 交流群：631348711</p></div>'),
    ctx.NapCatConfig.boolean('enableWorkflow', '启用工作流', true, '启用可视化工作流功能', true),
    ctx.NapCatConfig.boolean('debug', '调试模式', false, '显示详细日志')
  );

  // 加载配置
  if (fs.existsSync(ctx.configPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(ctx.configPath, 'utf-8'));
      pluginState.config = { ...DEFAULT_CONFIG, ...saved };
    } catch { }
  }

  // 确保数据目录存在
  if (!fs.existsSync(ctx.dataPath)) {
    fs.mkdirSync(ctx.dataPath, { recursive: true });
  }

  // 注册 Web UI 路由
  registerApiRoutes(ctx.router);

  // 注册静态资源
  ctx.router.static('/static', 'webui');

  // 注册工作流编辑页面
  ctx.router.page({
    path: 'workflow',
    title: '工作流编辑器',
    icon: '🔧',
    htmlFile: 'webui/workflow.html',
    description: '可视化工作流编辑器'
  });

  // 设置定时任务消息发送器和 API 调用器
  setMessageSender(
    async (targetType: string, targetId: string, messages: unknown[]) => {
      const action = targetType === 'group' ? 'send_group_msg' : 'send_private_msg';
      const params = targetType === 'group'
        ? { group_id: targetId, message: messages }
        : { user_id: targetId, message: messages };
      await ctx.actions.call(action, params as never, ctx.adapterName, ctx.pluginManager.config).catch(() => { });
    },
    async (action: string, params: Record<string, unknown>) => {
      return await ctx.actions.call(action, params as never, ctx.adapterName, ctx.pluginManager.config).catch(() => null);
    }
  );

  // 启动文件监听和定时任务调度器
  startWorkflowWatcher();
  startScheduler();

  pluginState.initialized = true;
  pluginState.log('info', '工作流插件初始化完成');
};

// 获取配置
export const plugin_get_config = async (): Promise<PluginConfig> => pluginState.config;

// 保存配置
export const plugin_set_config = async (ctx: NapCatPluginContext, config: PluginConfig): Promise<void> => {
  pluginState.config = config;
  if (ctx?.configPath) {
    const dir = path.dirname(ctx.configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ctx.configPath, JSON.stringify(config, null, 2), 'utf-8');
  }
};

// 响应式配置控制器
const plugin_config_controller = (_ctx: NapCatPluginContext, _ui: PluginConfigUIController, _config: Record<string, unknown>): (() => void) | void => {
  return () => { };
};

// 响应式配置变更
const plugin_on_config_change = (_ctx: NapCatPluginContext, _ui: PluginConfigUIController, _key: string, _value: unknown, _config: Record<string, unknown>): void => {
  // 暂无响应式逻辑
};

// 插件清理
const plugin_cleanup: PluginModule['plugin_cleanup'] = async () => {
  stopWorkflowWatcher();
  stopScheduler();
};

// 消息处理
const plugin_onmessage: PluginModule['plugin_onmessage'] = async (ctx: NapCatPluginContext, event: OB11Message) => {
  if (event.post_type !== EventType.MESSAGE) return;
  if (pluginState.config.enableWorkflow) {
    await handleMessage(event, ctx);
  }
};

export { plugin_init, plugin_onmessage, plugin_cleanup, plugin_config_controller, plugin_on_config_change };
