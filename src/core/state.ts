// 工作流插件全局状态
import type { PluginLogger } from 'napcat-types/napcat-onebot/network/plugin-manger';
import type { PluginConfig } from '../types';

// 默认配置
export const DEFAULT_CONFIG: PluginConfig = {
  enableWorkflow: true, debug: false, masters: [], masterPassword: '', ytApiKey: ''
};

// 插件状态
export const pluginState = {
  config: { ...DEFAULT_CONFIG } as PluginConfig,
  logger: null as PluginLogger | null,
  actions: null as unknown,
  adapterName: '',
  networkConfig: null as unknown,
  dataPath: '',
  pluginPath: '',
  initialized: false,
  botId: '' as string,  // 机器人QQ号

  // 日志
  log (level: 'info' | 'debug' | 'warn' | 'error', ...args: unknown[]): void {
    if (!this.logger || (level === 'debug' && !this.config.debug)) return;
    this.logger[level]?.(...args);
  },

  // 主人权限验证
  requireMasterAuth (): boolean { return !!this.config.masterPassword; },
  verifyMaster (password: string): boolean { return !this.config.masterPassword || password === this.config.masterPassword; },

  // 获取请求附加信息（用于 API 调用）
  getRequestMeta (): { bot_id: string; user_id: string; } {
    return { bot_id: this.botId, user_id: this.botId };
  },

  // 获取 AI API 配置（根据是否有第三方密钥决定）
  getAiConfig (): { url: string; key: string; useYtea: boolean; } {
    if (this.config.ytApiKey) {
      return { url: 'https://api.ytea.top/v1/chat/completions', key: this.config.ytApiKey, useYtea: true };
    }
    return { url: 'https://i.elaina.vin/api/openai/v1/chat/completions', key: '', useYtea: false };
  },
};
