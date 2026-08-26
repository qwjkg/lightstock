import axios from 'axios';

const api = axios.create({ baseURL: '/api' });
api.interceptors.request.use(cfg => {
  const t = localStorage.getItem('ls_token');
  if (t) cfg.headers.Authorization = 'Bearer ' + t;
  return cfg;
});
api.interceptors.response.use(r => r.data, err => {
  if (err.response && err.response.status === 401) {
    localStorage.removeItem('ls_token');
    if (location.hash !== '#/login') location.hash = '#/login';
  }
  return Promise.reject(err);
});

export async function downloadFile(url, filename) {
  const blob = await api.get(url, { responseType: 'blob' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename || 'download.xlsx';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 3000);
  link.remove();
}

export default api;
