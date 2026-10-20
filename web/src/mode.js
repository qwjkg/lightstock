import { computed, ref } from 'vue';
import api from './api';

// 全局界面模式。所有页面的「简易 / 高级」判断都从这里取，
// 不要在各自组件里重复判断——双模式最大的成本就是回归测试面翻倍。
const NAME_KEY = 'ls_business_name';
const cachedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };

export const mode = ref('simple');
// 店铺名会缓存到 localStorage：设了访问密码时登录页读不到 /api/settings，
// 但仍要能显示自己的店名。
export const businessName = ref(cachedName() || '我的店铺');
export const onboarded = ref(true);   // 默认 true，避免老用户看到引导闪一下
export const hasDemo = ref(false);
export const settingsLoaded = ref(false);

export const isSimple = computed(() => mode.value === 'simple');

export function applySettings(s) {
  if (s.ui_mode === 'simple' || s.ui_mode === 'advanced') mode.value = s.ui_mode;
  setBusinessName(s.business_name);
  onboarded.value = !!s.onboarded;
  hasDemo.value = !!s.has_demo;
  settingsLoaded.value = true;
}

// 店名改动后同步左上角 logo 与浏览器标签。
// 这里不发请求：若用户同时设置了访问密码，服务端会重置 token，再 GET /settings 会被跳到登录页。
export function setBusinessName(name) {
  businessName.value = name || '我的店铺';
  try { localStorage.setItem(NAME_KEY, businessName.value); } catch { /* 隐私模式下忽略 */ }
}

export async function loadSettings() {
  const s = await api.get('/settings');
  applySettings(s);
  return s;
}

// 切换模式并持久化
export async function switchMode(m) {
  mode.value = m === 'advanced' ? 'advanced' : 'simple';
  await api.put('/settings', { ui_mode: mode.value });
}