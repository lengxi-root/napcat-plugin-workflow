// 工作流插件全局状态
import type { PluginLogger } from 'napcat-types/napcat-onebot/network/plugin-manger';
import type { PluginConfig } from '../types';

// 默认配置
export const DEFAULT_CONFIG: PluginConfig = {
  enableWorkflow: true, debug: false, masters: [], masterPassword: ''
};

// 插件状态
export const pluginState = {
  config: { ...DEFAULT_CONFIG } as PluginConfig,
  logger: null as PluginLogger | null,
  actions: null as unknown,
  adapterName: '',
  networkConfig: null as unknown,
  dataPath: '',
  initialized: false,

  // 日志
  log(level: 'info' | 'debug' | 'warn' | 'error', ...args: unknown[]): void {
    if (!this.logger || (level === 'debug' && !this.config.debug)) return;
    this.logger[level]?.(...args);
  },

  // 主人权限验证
  requireMasterAuth(): boolean { return !!this.config.masterPassword; },
  verifyMaster(password: string): boolean { return !this.config.masterPassword || password === this.config.masterPassword; },
};
