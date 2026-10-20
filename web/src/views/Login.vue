<template>
  <div class="login-wrap">
    <el-card class="login-card">
      <h2 style="margin:0 0 6px">📦 {{ businessName }}</h2>
      <p class="tip">系统设置了访问密码，请输入密码进入</p>
      <el-input v-model="password" type="password" show-password placeholder="请输入访问密码" @keyup.enter="doLogin" />
      <el-button type="primary" style="width:100%;margin-top:14px" :loading="loading" @click="doLogin">进入系统</el-button>
    </el-card>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import api from '../api';
import { businessName } from '../mode';

const router = useRouter();
const password = ref('');
const loading = ref(false);

async function doLogin() {
  loading.value = true;
  try {
    const r = await api.post('/login', { password: password.value });
    if (r.token) localStorage.setItem('ls_token', r.token);
    ElMessage.success('登录成功');
    router.push('/');
  } catch (e) {
    ElMessage.error(e.response?.data?.error || '密码错误');
  } finally { loading.value = false; }
}
</script>

<style scoped>
.login-wrap { height: 100%; display: flex; align-items: center; justify-content: center; background: #f0f2f5; }
.login-card { width: 340px; }
.tip { color: #909399; font-size: 13px; margin: 0 0 14px; }
</style>
