// 工作流插件全局状态
import type { PluginLogger } from 'napcat-types/napcat-onebot/network/plugin-manger';
import type { PluginConfig } from '../types';

// 默认配置
export const DEFAULT_CONFIG: PluginConfig = {
  enableWorkflow: true,
  debug: false,
  masters: [],  // 主人QQ列表
  masterPassword: '',  // 主人验证密码（为空则不启用权限控制）
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

  log (level: 'info' | 'debug' | 'warn' | 'error', ...args: unknown[]): void {
    if (!this.logger) return;
    if (level === 'debug' && !this.config.debug) return;
    this.logger[level]?.(...args);
  },

  // 检查是否需要主人权限
  requireMasterAuth (): boolean {
    return !!this.config.masterPassword;
  },

  // 验证主人密码
  verifyMaster (password: string): boolean {
    if (!this.config.masterPassword) return true;
    return password === this.config.masterPassword;
  },
};
