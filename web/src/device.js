// 手机版 / 电脑版的布局偏好。
// 判断只在「首次进入」做一次：电脑用户把窗口拖窄，不应该被强行弹到手机版。
const KEY = 'ls_layout_pref';   // 'mobile' | 'desktop' | ''（跟随屏幕宽度）

export function layoutPref() {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export function setLayoutPref(v) {
  try { localStorage.setItem(KEY, v); } catch { /* 隐私模式下忽略 */ }
}

export function isNarrowScreen() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
}

// 有明确偏好时以偏好为准，否则看屏幕宽度
export function prefersMobile() {
  const p = layoutPref();
  if (p === 'mobile') return true;
  if (p === 'desktop') return false;
  return isNarrowScreen();
}

export function homeForDevice() {
  return prefersMobile() ? '/m/stock' : '/dashboard';
}