import { chatWithTools, getAiConfig, scrubSecret } from './provider.js';
import { buildContext, buildSystemPrompt } from './prompt.js';
import { toolDefsFor, executeTool } from './tools.js';
import { getPermission } from './permissions.js';
import { logAiAudit } from './audit.js';

const MAX_ROUNDS = 6;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TOOL_RESULT_CHARS = 14000;
const MAX_CARDS = 6;

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_MESSAGES)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
}

function plainAssistantMessage(message) {
  const out = { role: 'assistant', content: typeof message.content === 'string' ? message.content : '' };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    out.tool_calls = message.tool_calls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' }
    }));
  }
  return out;
}

function maskSensitive(text) {
  // 默认 business 隐私级别：工具结果里的手机号先遮掉，再交给模型。
  // 地址/联系人字段本身不在只读工具返回里；备注里的手机号用这个兜底。
  return String(text).replace(/1[3-9]\d{9}/g, '1**********');
}

function resultForModel(result) {
  // cards 只给前端，不重复塞进模型上下文；
  // 写操作提案里的 confirm_token 也绝不能给模型，否则 prompt injection 可能伪造确认。
  const { cards, ...rest } = result || {};
  if (rest.action) {
    const { confirm_token, ...safeAction } = rest.action;
    rest.action = safeAction;
  }
  const text = JSON.stringify(rest);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return maskSensitive(text);
  return maskSensitive(JSON.stringify({
    ok: rest.ok,
    as_of: rest.as_of,
    data: { summary: '结果过大，已省略明细；请缩小查询范围，或让用户查看前端数据卡片' },
    meta: { ...(rest.meta || {}), truncated: true },
    notes: rest.notes || []
  }));
}

function cardKey(card) {
  return `${card.type || ''}|${card.title || ''}`;
}

function toolCallKey(name, args) {
  try { return `${name}|${JSON.stringify(args)}`; } catch { return `${name}|`; }
}

export async function runAgent({ session, messages, provider = chatWithTools }) {
  const started = Date.now();
  const ctx = buildContext();
  const permission = getPermission(session);
  const system = buildSystemPrompt(ctx, permission.level);
  const clean = sanitizeMessages(messages);
  if (!clean.length || clean[clean.length - 1].role !== 'user') {
    const err = new Error('请先输入问题');
    err.code = 'INVALID_MESSAGES';
    throw err;
  }

  const conversation = [{ role: 'system', content: system }, ...clean];
  const tools = toolDefsFor(permission.level);
  const cards = [];
  const cardKeys = new Set();
  const actions = [];
  const toolCalls = [];
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let model = getAiConfig().model;
  let reply = '';
  let error = '';

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await provider({
        messages: conversation,
        tools,
        temperature: 0.1,
        maxTokens: 1400
      });
      model = res.model || model;
      usage.prompt_tokens += Number(res.usage?.prompt_tokens) || 0;
      usage.completion_tokens += Number(res.usage?.completion_tokens) || 0;

      const msg = res.message || {};
      const assistant = plainAssistantMessage(msg);
      conversation.push(assistant);

      if (!assistant.tool_calls || !assistant.tool_calls.length) {
        reply = assistant.content || '';
        break;
      }

      for (const tc of assistant.tool_calls) {
        const name = tc.function?.name || '';
        let args = {};
        let parseError = '';
        try {
          const raw = tc.function?.arguments;
          args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
        } catch {
          parseError = '工具参数不是合法 JSON';
        }

        const toolStarted = Date.now();
        let out;
        if (parseError) {
          out = { ok: false, code: 'INVALID_ARG', error: parseError };
        } else {
          out = executeTool(name, args, { session, permission });
        }
        const ms = Date.now() - toolStarted;

        if (out.action) {
          actions.push(out.action);
          logAiAudit({
            session_id: session.id,
            user_id: session.actor?.id,
            actor_type: session.actor?.type,
            auth_method: session.actor?.auth_method,
            role: session.actor?.role,
            kind: 'action',
            tool_name: name,
            args_json: args,
            result_summary: `${out.action.type} 待确认`,
            permission_level: permission.level,
            action_id: out.action.action_id,
            action_status: 'proposed',
            model
          });
        }

        const callKey = toolCallKey(name, args);
        for (const card of out.cards || []) {
          // 同一个工具、同一组参数只保留一份卡片；不同仓库/筛选条件各自保留。
          const key = `${callKey}|${cardKey(card)}`;
          if (cards.length < MAX_CARDS && !cardKeys.has(key)) {
            cardKeys.add(key);
            cards.push(card);
          }
        }
        toolCalls.push({
          name,
          args,
          ok: out.ok !== false,
          ms,
          row_count: out.meta?.row_count ?? 0
        });

        conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultForModel(out)
        });

        logAiAudit({
          session_id: session.id,
          user_id: session.actor?.id,
          actor_type: session.actor?.type,
          auth_method: session.actor?.auth_method,
          role: session.actor?.role,
          kind: 'tool',
          tool_name: name,
          args_json: args,
          result_summary: out.ok === false ? out.error : `${out.meta?.row_count ?? 0} 行`,
          permission_level: permission.level,
          model,
          duration_ms: ms,
          error: out.ok === false ? out.error : ''
        });
      }
    }

    if (!reply) {
      reply = toolCalls.length
        ? '查询步骤有点多，我先给出已经查到的数据。你可以把问题拆小一点再问。'
        : '模型没有返回内容，请换个问法或稍后重试。';
    }

    // 防谎报兜底：用户明显在问数据，但模型没有调用任何业务数据工具
// （get_context/resolve_entity 不算），且回答里出现了数字，就加警告卡片。
// 正常“怎么用”类问题不会命中这些词；纯澄清问题通常不带数字，也不会误报。
    const DATA_TOOLS = new Set([
      'stock_summary', 'stock_list', 'low_stock', 'ledger_query',
      'order_list', 'order_detail', 'purchase_report', 'sales_report',
      'profit_report', 'dashboard_overview'
    ]);
    const lastUser = clean[clean.length - 1].content || '';
    const dataIntent = /(多少|多少钱|价值|金额|总额|毛利|利润|销售额|低库存|负库存|快没货|流水|报表|盘点|库存情况|卖得最好)/.test(lastUser);
    const hasDataTool = toolCalls.some(t => DATA_TOOLS.has(t.name));
    const looksNumeric = /(¥|￥)\s*[0-9]|[0-9０-９]\s*(元|件|公斤|斤|克|吨|个|条|单|箱|打)/.test(reply);
    if (!hasDataTool && !actions.length && dataIntent && looksNumeric) {
      cards.unshift({
        type: 'warning',
        title: '未查询数据',
        text: '本条回答没有调用业务数据查询工具，数字不可作为依据。请让 AI 先查询，或换个更具体的问法。'
      });
      reply += '\n\n（提示：本条回答未查询数据，数字不可作为依据。）';
    }
  } catch (e) {
    error = scrubSecret(e.message || 'AI 调用失败');
    logAiAudit({
      session_id: session.id,
      user_id: session.actor?.id,
      actor_type: session.actor?.type,
      auth_method: session.actor?.auth_method,
      role: session.actor?.role,
      kind: 'chat',
      permission_level: permission.level,
      model,
      duration_ms: Date.now() - started,
      error
    });
    const wrapped = new Error(error);
    wrapped.code = e.code || 'AI_ERROR';
    throw wrapped;
  }

  logAiAudit({
    session_id: session.id,
    user_id: session.actor?.id,
    actor_type: session.actor?.type,
    auth_method: session.actor?.auth_method,
    role: session.actor?.role,
    kind: 'chat',
    permission_level: permission.level,
    result_summary: `${toolCalls.length} 个工具调用`,
    model,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    duration_ms: Date.now() - started,
    error
  });

  return {
    reply,
    cards,
    actions,
    tool_calls: toolCalls,
    usage,
    model,
    permission,
    actor: session.actor
  };
}