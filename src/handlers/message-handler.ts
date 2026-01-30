// 工作流消息处理器
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin-manger';
import type { OB11Message } from 'napcat-types/napcat-onebot/types/index';
import type { MessageEvent, ReplyFunctions } from '../types';
import { pluginState } from '../core/state';
import { loadWorkflows } from '../services/storage';
import { execute } from '../services/executor';

// 创建回复函数集
function createReplyFunctions (event: OB11Message, ctx: NapCatPluginContext): ReplyFunctions {
  const sendMsg = async (message: unknown[]) => {
    const action = event.message_type === 'group' ? 'send_group_msg' : 'send_private_msg';
    const id = event.message_type === 'group' ? { group_id: String(event.group_id) } : { user_id: String(event.user_id) };
    try { await ctx.actions.call(action, { ...id, message } as never, ctx.adapterName, ctx.pluginManager.config); }
    catch (e) { pluginState.log('error', '消息发送失败:', e); }
  };

  return {
    reply: async (content: string) => { await sendMsg([{ type: 'text', data: { text: content } }]); },
    replyImage: async (url: string | Buffer, text?: string) => {
      const msg: unknown[] = [typeof url === 'string' ? { type: 'image', data: { file: url } } : { type: 'image', data: { file: `base64://${url.toString('base64')}` } }];
      if (text) msg.push({ type: 'text', data: { text } });
      await sendMsg(msg);
    },
    replyVoice: async (url: string | Buffer) => { await sendMsg([{ type: 'record', data: { file: typeof url === 'string' ? url : `base64://${url.toString('base64')}` } }]); },
    replyVideo: async (url: string | Buffer) => { await sendMsg([{ type: 'video', data: { file: typeof url === 'string' ? url : `base64://${url.toString('base64')}` } }]); },
    replyForward: async (messages: string[]) => {
      const nodes = messages.map(content => ({ type: 'node', data: { user_id: String(event.self_id || '10000'), nickname: '工作流', content: [{ type: 'text', data: { text: content } }] } }));
      const action = event.message_type === 'group' ? 'send_group_forward_msg' : 'send_private_forward_msg';
      const id = event.message_type === 'group' ? { group_id: String(event.group_id) } : { user_id: String(event.user_id) };
      await ctx.actions.call(action, { ...id, messages: nodes } as never, ctx.adapterName, ctx.pluginManager.config).catch(() => { });
    },
    replyAt: async (content: string) => { await sendMsg([{ type: 'at', data: { qq: String(event.user_id) } }, { type: 'text', data: { text: ' ' + content } }]); },
    replyFace: async (faceId: number) => { await sendMsg([{ type: 'face', data: { id: String(faceId) } }]); },
    replyPoke: async (userId: string) => { await sendMsg([{ type: 'poke', data: { qq: userId } }]); },
    replyJson: async (data: unknown) => { await sendMsg([{ type: 'json', data: { data: JSON.stringify(data) } }]); },
    replyFile: async (url: string, name?: string) => { await sendMsg([{ type: 'file', data: { file: url, name: name || 'file' } }]); },
    replyMusic: async (type: string, id: string) => { await sendMsg([{ type: 'music', data: { type, id } }]); },
    groupSign: async () => {
      if (event.message_type !== 'group' || !event.group_id) return;
      await ctx.actions.call('send_group_sign', { group_id: String(event.group_id) } as never, ctx.adapterName, ctx.pluginManager.config).catch(() => {});
    },
    groupBan: async (userId: string, duration: number) => {
      if (event.message_type !== 'group' || !event.group_id) return;
      await ctx.actions.call('set_group_ban', { group_id: String(event.group_id), user_id: userId, duration } as never, ctx.adapterName, ctx.pluginManager.config).catch(() => { });
    },
    groupKick: async (userId: string, rejectAdd = false) => {
      if (event.message_type !== 'group' || !event.group_id) return;
      await ctx.actions.call('set_group_kick', { group_id: String(event.group_id), user_id: userId, reject_add_request: rejectAdd } as never, ctx.adapterName, ctx.pluginManager.config).catch(() => { });
    },
    groupWholeBan: async (enable: boolean) => {
      if (event.message_type !== 'group' || !event.group_id) return;
      await ctx.actions.call('set_group_whole_ban', { group_id: String(event.group_id), enable } as never, ctx.adapterName, ctx.pluginManager.config).catch(() => { });
    },
    groupSetCard: async (userId: string, card: string) => {
      if (event.message_type !== 'group' || !event.group_id) return;
      await ctx.actions.call('set_group_card', { group_id: String(event.group_id), user_id: userId, card } as never, ctx.adapterName, ctx.pluginManager.config).catch(() => { });
    },
    groupSetAdmin: async (userId: string, enable: boolean) => {
      if (event.message_type !== 'group' || !event.group_id) return;
      await ctx.actions.call('set_group_admin', { group_id: String(event.group_id), user_id: userId, enable } as never, ctx.adapterName, ctx.pluginManager.config).catch(() => { });
    },
    groupNotice: async (content: string) => {
      if (event.message_type !== 'group' || !event.group_id) return;
      await ctx.actions.call('_send_group_notice', { group_id: String(event.group_id), content } as never, ctx.adapterName, ctx.pluginManager.config).catch(() => { });
    },
    callApi: async (action: string, params: Record<string, unknown>) => {
      return await ctx.actions.call(action, params as never, ctx.adapterName, ctx.pluginManager.config).catch(() => null);
    },
  };
}

// 处理消息
export async function handleMessage (event: OB11Message, ctx: NapCatPluginContext): Promise<boolean> {
  if (!pluginState.config.enableWorkflow) return false;

  const content = (event.raw_message || '').trim();
  if (!content) return false;

  const workflows = loadWorkflows();
  if (!workflows.length) return false;

  const msgEvent: MessageEvent = {
    user_id: String(event.user_id),
    group_id: event.group_id ? String(event.group_id) : undefined,
    message_type: event.message_type as 'group' | 'private',
    raw_message: event.raw_message || '',
    message: event.message as unknown[],
    self_id: (event as { self_id?: number; }).self_id,
    sender: event.sender as MessageEvent['sender'],
  };

  const reply = createReplyFunctions(event, ctx);

  for (const workflow of workflows) {
    if (!workflow.enabled) continue;
    try {
      const executed = await execute(workflow, msgEvent, content, reply);
      if (executed) {
        pluginState.log('debug', `工作流 [${workflow.name}] 执行成功`);
        if (workflow.stop_propagation) return true;
      }
    } catch (e) {
      pluginState.log('error', `工作流 [${workflow.name}] 执行失败:`, e);
    }
  }
  return false;
}
