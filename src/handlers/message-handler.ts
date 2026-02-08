// 工作流消息处理器
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin-manger';
import type { OB11Message } from 'napcat-types/napcat-onebot/types/index';
import type { MessageEvent, ReplyFunctions } from '../types';
import { pluginState } from '../core/state';
import { loadWorkflows } from '../services/storage';
import { execute } from '../services/executor';
import { parseCQCode, toFile } from '../utils/cq-parser';

// 创建回复函数集
function createReplyFunctions (event: OB11Message, ctx: NapCatPluginContext): ReplyFunctions {
  const isGroup = event.message_type === 'group';
  const groupId = String(event.group_id), userId = String(event.user_id);

  // 通用消息发送
  const send = async (msg: unknown[]) => {
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const params = isGroup ? { group_id: groupId, message: msg } : { user_id: userId, message: msg };
    await ctx.actions.call(action, params as never, ctx.adapterName, ctx.pluginManager.config).catch(e => pluginState.log('error', '消息发送失败:', e));
  };

  // 群管理操作
  const groupAction = async (action: string, params: Record<string, unknown>) => {
    if (!isGroup || !event.group_id) return;
    await ctx.actions.call(action, { group_id: groupId, ...params } as never, ctx.adapterName, ctx.pluginManager.config).catch(() => { });
  };

  return {
    reply: async (c) => send(parseCQCode(c)),
    replyImage: async (url, text) => { const msg: unknown[] = [{ type: 'image', data: { file: toFile(url) } }]; if (text) msg.push({ type: 'text', data: { text } }); await send(msg); },
    replyVoice: async (url) => send([{ type: 'record', data: { file: toFile(url) } }]),
    replyVideo: async (url) => send([{ type: 'video', data: { file: toFile(url) } }]),
    replyForward: async (msgs) => {
      const nodes = msgs.map(c => ({ type: 'node', data: { user_id: String(event.self_id || '10000'), nickname: '工作流', content: parseCQCode(c) } }));
      const action = isGroup ? 'send_group_forward_msg' : 'send_private_forward_msg';
      const params = isGroup ? { group_id: groupId, messages: nodes } : { user_id: userId, messages: nodes };
      await ctx.actions.call(action, params as never, ctx.adapterName, ctx.pluginManager.config).catch(() => { });
    },
    replyAt: async (c) => send([{ type: 'at', data: { qq: userId } }, { type: 'text', data: { text: ' ' + c } }]),
    replyFace: async (id) => send([{ type: 'face', data: { id: String(id) } }]),
    replyPoke: async (uid) => send([{ type: 'poke', data: { qq: uid } }]),
    replyJson: async (d) => send([{ type: 'json', data: { data: JSON.stringify(d) } }]),
    replyFile: async (url, name) => send([{ type: 'file', data: { file: url, name: name || 'file' } }]),
    replyMusic: async (type, id) => send([{ type: 'music', data: { type, id } }]),
    groupSign: () => groupAction('send_group_sign', {}),
    groupBan: (uid, duration) => groupAction('set_group_ban', { user_id: uid, duration }),
    groupKick: (uid, reject = false) => groupAction('set_group_kick', { user_id: uid, reject_add_request: reject }),
    groupWholeBan: (enable) => groupAction('set_group_whole_ban', { enable }),
    groupSetCard: (uid, card) => groupAction('set_group_card', { user_id: uid, card }),
    groupSetAdmin: (uid, enable) => groupAction('set_group_admin', { user_id: uid, enable }),
    groupNotice: (c) => groupAction('_send_group_notice', { content: c }),
    recallMsg: async (msgId) => { await ctx.actions.call('delete_msg', { message_id: msgId } as never, ctx.adapterName, ctx.pluginManager.config).catch(() => { }); },
    callApi: async (action, params) => await ctx.actions.call(action, params as never, ctx.adapterName, ctx.pluginManager.config).catch(() => null),
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
    message_id: (event as { message_id?: string | number; }).message_id,
    self_id: (event as { self_id?: number; }).self_id,
    sender: event.sender as MessageEvent['sender'],
  };

  const reply = createReplyFunctions(event, ctx);

  for (const wf of workflows) {
    if (!wf.enabled) continue;
    try {
      if (await execute(wf, msgEvent, content, reply)) {
        pluginState.log('debug', `工作流 [${wf.name}] 执行成功`);
        if (wf.stop_propagation) return true;
      }
    } catch (e) { pluginState.log('error', `工作流 [${wf.name}] 执行失败:`, e); }
  }
  return false;
}
