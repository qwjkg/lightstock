<template>
  <el-dialog v-model="visible" title="欢迎使用" width="600px"
             :close-on-click-modal="false" :show-close="false" append-to-body>
    <el-steps :active="step" simple style="margin-bottom:18px">
      <el-step title="欢迎" />
      <el-step title="店铺信息" />
      <el-step title="示例数据" />
      <el-step title="完成" />
    </el-steps>

    <div v-if="step === 0">
      <p class="lead">第一次使用，<b>三步</b>就能开始记账：建商品 → 进货 → 看库存。</p>
      <el-form label-width="90px">
        <el-form-item label="界面模式">
          <el-radio-group v-model="form.ui_mode">
            <el-radio-button value="simple">简易（推荐）</el-radio-button>
            <el-radio-button value="advanced">高级</el-radio-button>
          </el-radio-group>
          <div class="tip">简易模式会隐藏计量单位、自定义字段等进阶功能，随时可在设置里切换。</div>
        </el-form-item>
      </el-form>
    </div>

    <div v-else-if="step === 1">
      <el-form label-width="90px">
        <el-form-item label="店铺名称">
          <el-input v-model="form.business_name" placeholder="如：张记便利店" />
        </el-form-item>
        <el-form-item label="仓库名称">
          <el-input v-model="form.warehouse_name" placeholder="默认：主仓库" />
        </el-form-item>
      </el-form>
      <div class="tip">只有一个小库房的话，仓库名保持默认即可。</div>
    </div>

    <div v-else-if="step === 2">
      <el-checkbox v-model="form.with_demo">添加 3 个示例商品（熟悉操作后可在设置里一键清除）</el-checkbox>
      <ul class="demo-list">
        <li v-for="p in demoList" :key="p.name">
          {{ p.name }}<span class="muted">　进价 {{ p.purchase_price.toFixed(2) }} / 售价 {{ p.sale_price.toFixed(2) }}</span>
        </li>
      </ul>
    </div>

    <div v-else>
      <p class="lead">✅ 设置完成！</p>
      <p class="muted">
        接下来建议：去「商品管理」添加你自己的商品，再到「进货管理」录入第一笔进货，库存会自动增加。
      </p>
      <p class="muted">录错的单据可以在「进货/出货管理」里点「作废」，库存会自动冲回。</p>
    </div>

    <template #footer>
      <el-button v-if="step < 3" link @click="skip">跳过引导</el-button>
      <el-button v-if="step > 0" @click="step--">上一步</el-button>
      <el-button v-if="step < 3" type="primary" @click="next">下一步</el-button>
      <el-button v-else type="primary" :loading="saving" @click="finish">开始使用</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../api';
import { loadSettings, setBusinessName } from '../mode';

const visible = ref(true);
const step = ref(0);
const saving = ref(false);
const demoList = [
  { name: '矿泉水 550ml', purchase_price: 1, sale_price: 2 },
  { name: '方便面（红烧牛肉）', purchase_price: 2.5, sale_price: 4 },
  { name: '抽纸（软包）', purchase_price: 3.2, sale_price: 5 }
];
const form = reactive({ ui_mode: 'simple', business_name: '', warehouse_name: '主仓库', with_demo: true });

// 离开「店铺信息」这一步就把店名存下来，左上角 logo 立刻跟着变，
// 不必等到最后一步，也避免用户中途关掉就白填了。
async function next() {
  if (step.value === 1) {
    const name = form.business_name.trim();
    if (name) {
      try {
        await api.put('/settings', { business_name: name });
        setBusinessName(name);
      } catch { /* 失败不阻断，最后一步还会再存一次 */ }
    }
  }
  step.value++;
}

async function finish() {
  saving.value = true;
  try {
    if (form.business_name.trim()) await api.put('/settings', { business_name: form.business_name.trim() });

    // 仓库已存在同名则跳过；若全新库里只有系统预置的「主仓库」，直接改名而不是新建，
    // 免得给新手留下一个空的「主仓库」。
    const name = form.warehouse_name.trim() || '主仓库';
    const warehouses = await api.get('/warehouses');
    if (!warehouses.some(w => w.name === name)) {
      const only = warehouses.length === 1 ? warehouses[0] : null;
      if (only && only.name === '主仓库') await api.put('/warehouses/' + only.id, { ...only, name });
      else await api.post('/warehouses', { name });
    }

    if (form.with_demo) await api.post('/demo/seed');
    await api.put('/settings', { ui_mode: form.ui_mode, onboarded: true });
    await loadSettings();
    ElMessage.success('设置完成，开始使用吧！');
    visible.value = false;
  } catch (e) {
    ElMessage.error('保存失败：' + (e.response?.data?.error || e.message));
  } finally {
    saving.value = false;
  }
}

async function skip() {
  try {
    await api.put('/settings', { onboarded: true });
    await loadSettings();
  } catch { /* 跳过失败不阻断使用 */ }
  visible.value = false;
}
</script>

<style scoped>
.lead { font-size: 15px; margin: 0 0 14px; }
.tip { color: #909399; font-size: 12px; line-height: 1.7; margin-top: 6px; }
.muted { color: #606266; font-size: 13px; line-height: 1.9; }
.demo-list { margin: 10px 0 0 6px; padding-left: 16px; color: #606266; font-size: 13px; line-height: 2; }
</style>