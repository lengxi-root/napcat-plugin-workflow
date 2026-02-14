// 工作流插件类型定义

// 插件配置
export interface PluginConfig {
  enableWorkflow: boolean;
  debug: boolean;
  masters: string[];
  masterPassword: string;
  ytApiKey: string;  // api.ytea.top 第三方密钥，填写后 AI 功能直连 api.ytea.top
  [key: string]: unknown;
}

// 工作流定义
export interface Workflow {
  id: string; name: string; trigger_type: string; trigger_content: string;
  enabled: boolean; stop_propagation?: boolean;
  nodes: WorkflowNode[]; connections: WorkflowConnection[];
}

// 工作流节点
export interface WorkflowNode { id: string; type: string; x: number; y: number; data: Record<string, unknown>; }

// 工作流连接
export interface WorkflowConnection { from_node: string; from_output: string; to_node: string; }

// 执行上下文
export interface ExecutionContext { regex_groups: string[];[key: string]: unknown; }

// 消息事件
export interface MessageEvent {
  user_id: string; group_id?: string; message_type: 'group' | 'private';
  raw_message: string; message: unknown[]; self_id?: number; message_id?: string | number;
  sender?: { nickname?: string; card?: string; sex?: string; };
}

// 回复函数集
export interface ReplyFunctions {
  reply: (content: string) => Promise<void>;
  replyImage: (url: string | Buffer, text?: string) => Promise<void>;
  replyVoice: (url: string | Buffer) => Promise<void>;
  replyVideo: (url: string | Buffer) => Promise<void>;
  replyForward: (messages: string[]) => Promise<void>;
  replyAt: (content: string) => Promise<void>;
  replyFace: (faceId: number) => Promise<void>;
  replyPoke: (userId: string) => Promise<void>;
  replyJson: (data: unknown) => Promise<void>;
  replyFile: (url: string, name?: string) => Promise<void>;
  replyMusic: (type: string, id: string) => Promise<void>;
  groupSign: () => Promise<void>;
  groupBan: (userId: string, duration: number) => Promise<void>;
  groupKick: (userId: string, rejectAdd?: boolean) => Promise<void>;
  groupWholeBan: (enable: boolean) => Promise<void>;
  groupSetCard: (userId: string, card: string) => Promise<void>;
  groupSetAdmin: (userId: string, enable: boolean) => Promise<void>;
  groupNotice: (content: string) => Promise<void>;
  recallMsg: (messageId: string) => Promise<void>;
  callApi: (action: string, params: Record<string, unknown>) => Promise<unknown>;
}

// 节点配置
export interface NodeConfig {
  title: string; icon: string; color: string; inputs: number; outputs: number;
  fields?: NodeField[]; customEdit?: boolean;
}

// 节点字段
export interface NodeField {
  name: string; label: string; type: 'text' | 'number' | 'select' | 'textarea';
  options?: { value: string; label: string; }[]; default?: unknown; placeholder?: string;
}

// 定时任务
export interface ScheduledTask {
  id: string; workflow_id: string; task_type: 'daily' | 'interval' | 'cron';
  daily_time?: string; interval_seconds?: number; weekdays?: number[];
  target_type: 'group' | 'private'; target_id: string; trigger_user_id?: string;
  enabled: boolean; last_run?: string; run_count: number; description?: string;
}

// 需要主人权限的触发器
export const MASTER_ONLY_TRIGGERS = ['regex', 'any', 'scheduled', 'timer'];
