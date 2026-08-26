// 简单的访问密码鉴权：内存 token（重启后需重新登录）
const tokens = new Set();

export function issueToken() {
  const t = 'tk_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  tokens.add(t);
  return t;
}
export function hasToken(t) {
  return tokens.has(t);
}
export function resetTokens() {
  tokens.clear();
}
