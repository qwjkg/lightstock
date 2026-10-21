import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { dataDir, getSetting } from '../db.js';

// API Key 不写入 settings / 数据库备份。优先级：
//   1) 环境变量 AI_API_KEY 或 DEEPSEEK_API_KEY
//   2) server/data/ai.key（设置页写入，仅本机可写）
const KEY_FILE = path.join(dataDir, 'ai.key');

function readKeyFile() {
  try {
    return fs.readFileSync(KEY_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

export function getAiConfig() {
  const envKey = process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || '';
  const key = String(envKey || readKeyFile()).trim();
  const baseURL = process.env.AI_BASE_URL || getSetting('ai_base_url', '') || 'https://api.deepseek.com';
  const model = process.env.AI_MODEL || getSetting('ai_model', '') || 'deepseek-chat';
  const enabled = getSetting('ai_enabled', '1') !== '0';
  return {
    key,
    baseURL,
    model,
    enabled,
    configured: !!key,
    key_source: envKey ? 'env' : (key ? 'file' : 'none'),
    key_hint: key && key.length > 8 ? `****${key.slice(-4)}` : (key ? '****' : '')
  };
}

export function saveApiKey(key) {
  const value = String(key || '').trim();
  if (!value) throw new Error('API Key 不能为空');
  fs.mkdirSync(dataDir, { recursive: true });
  // 先写临时文件再改名，避免进程中断留下半个 Key 文件。
  const tmp = KEY_FILE + '.tmp';
  fs.writeFileSync(tmp, value, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, KEY_FILE);
}

export function clearApiKey() {
  try { fs.unlinkSync(KEY_FILE); } catch { /* 不存在就忽略 */ }
}

// 错误信息里可能夹带 Key/请求头，返回给前端或写审计前先抹掉。
export function scrubSecret(text) {
  return String(text ?? '').replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}

// 统一的模型调用入口。DeepSeek 与 OpenAI 的工具调用格式一致，
// 换供应商只要改 AI_BASE_URL / AI_MODEL。
export async function chatWithTools({ messages, tools, temperature = 0.1, maxTokens = 1200 }) {
  const cfg = getAiConfig();
  if (!cfg.enabled) {
    const err = new Error('AI 助手已在设置中关闭');
    err.code = 'AI_DISABLED';
    throw err;
  }
  if (!cfg.configured) {
    const err = new Error('AI 未配置 API Key，请先在设置中填写，或设置 AI_API_KEY 环境变量');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }

  const client = new OpenAI({
    apiKey: cfg.key,
    baseURL: cfg.baseURL,
    timeout: 60_000,
    maxRetries: 1
  });

  const params = {
    model: cfg.model,
    messages,
    temperature,
    max_tokens: maxTokens
  };
  if (tools && tools.length) {
    params.tools = tools;
    params.tool_choice = 'auto';
  }

  const started = Date.now();
  const res = await client.chat.completions.create(params);
  const choice = res.choices && res.choices[0];
  return {
    message: choice?.message || { role: 'assistant', content: '' },
    finish_reason: choice?.finish_reason || '',
    usage: res.usage || {},
    model: res.model || cfg.model,
    duration_ms: Date.now() - started
  };
}