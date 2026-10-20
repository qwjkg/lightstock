import { ElMessage, ElMessageBox } from 'element-plus';

// 后端统一用 { error: '...' } 返回错误，这里统一取文案。
export function errorText(e, fallback = '操作失败') {
  return e?.response?.data?.error || fallback;
}

export function showError(e, fallback) {
  ElMessage.error(errorText(e, fallback));
}

// ElMessageBox.confirm 在点「取消」时会 reject。
// 各页面直接 await 会留下未捕获的 Promise 异常，统一在这里吞掉。
export async function confirmAction(message, title = '确认', options = {}) {
  try {
    await ElMessageBox.confirm(message, title, { type: 'warning', ...options });
    return true;
  } catch {
    return false;
  }
}

// 把「同名记录已停用」的 409 响应整理成可展示的 { inactiveId }，否则返回 null
export function inactiveConflict(e) {
  const d = e?.response?.data;
  if (e?.response?.status === 409 && d?.inactive_id) {
    return { id: d.inactive_id, message: d.error || '同名记录已停用' };
  }
  return null;
}