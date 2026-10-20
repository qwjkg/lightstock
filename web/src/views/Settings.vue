<template>
  <el-tabs v-model="tab">
    <el-tab-pane label="基本设置" name="base">
      <el-form label-width="140px" style="max-width:520px">
        <el-form-item label="店铺/公司名称"><el-input v-model="form.business_name" /></el-form-item>
        <el-form-item label="界面模式">
          <el-radio-group v-model="uiMode">
            <el-radio-button value="simple">简易</el-radio-button>
            <el-radio-button value="advanced">高级</el-radio-button>
          </el-radio-group>
          <div class="tip">
            简易模式只保留日常记账要用的功能（隐藏计量单位、自定义字段等），已录入的数据不受影响，随时可切回。
          </div>
        </el-form-item>
        <el-form-item label="自动备份间隔(小时)"><el-input-number v-model="form.auto_backup_hours" :min="1" /></el-form-item>
        <el-form-item label="访问密码">
          <el-input v-model="form.access_password" type="password" show-password placeholder="输入新密码可设置/修改；不修改请留空" @input="passwordDirty = true" />
          <el-checkbox v-if="passwordRequired && !passwordDirty" v-model="clearPassword" style="margin-top:6px">清除已设置的访问密码</el-checkbox>
        </el-form-item>
        <el-form-item><el-button type="primary" @click="saveBase">保存设置</el-button></el-form-item>
        <el-form-item v-if="hasDemo" label="示例数据">
          <el-button @click="clearDemo">清除示例数据</el-button>
          <div class="tip">删除首次引导时添加的示例商品；已产生进出货记录的商品会保留并提示。</div>
        </el-form-item>
      </el-form>
      <el-alert type="info" :closable="false" title="使用提示" description="本系统数据保存在 server/data/warehouse.db 单文件中，复制该文件即可整体备份；如需局域网/手机访问，直接在同一网络下用手机浏览器打开电脑 IP（服务启动时会显示）。" />
    </el-tab-pane>

    <!-- 仓库：简易模式下收进设置页，高级模式仍保留独立菜单 -->
    <el-tab-pane v-if="isSimple" label="仓库" name="warehouse">
      <Warehouses />
    </el-tab-pane>

    <el-tab-pane v-if="!isSimple" label="自定义字段" name="fields">
      <div class="toolbar">
        <el-select v-model="fieldEntity" style="width:200px" @change="loadFields">
          <el-option v-for="e in entities" :key="e.value" :label="e.label" :value="e.value" />
        </el-select>
        <el-button type="primary" @click="openField()">新增字段</el-button>
        <span class="tip">自定义字段会显示在商品/往来单位/单据的录入表单中</span>
      </div>
      <el-table :data="fields" border size="small">
        <el-table-column prop="label" label="显示名" width="140" />
        <el-table-column prop="name" label="字段名(英文)" width="160" />
        <el-table-column label="类型" width="100">
          <template #default="{ row }">{{ fieldTypeText(row.field_type) }}</template>
        </el-table-column>
        <el-table-column prop="options" label="选项(下拉)" show-overflow-tooltip />
        <el-table-column label="必填" width="70">
          <template #default="{ row }">{{ row.required ? '是' : '否' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button link type="primary" @click="openField(row)">编辑</el-button>
            <el-button link type="danger" @click="removeField(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-dialog v-model="fieldDialog" title="字段定义" width="480px">
        <el-form label-width="90px">
          <el-form-item label="实体">
            <el-select v-model="fieldForm.entity" style="width:100%">
              <el-option v-for="e in entities" :key="e.value" :label="e.label" :value="e.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="显示名" required><el-input v-model="fieldForm.label" placeholder="如：产地" /></el-form-item>
          <el-form-item label="字段名" required><el-input v-model="fieldForm.name" placeholder="英文，如：origin" /></el-form-item>
          <el-form-item label="类型">
            <el-select v-model="fieldForm.field_type" style="width:100%">
              <el-option label="文本" value="text" />
              <el-option label="数字" value="number" />
              <el-option label="日期" value="date" />
              <el-option label="下拉选项" value="select" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="fieldForm.field_type === 'select'" label="选项">
            <el-input v-model="optionsText" placeholder="用逗号分隔，如：国产,进口" />
          </el-form-item>
          <el-form-item label="必填"><el-switch v-model="fieldForm.required" /></el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="fieldDialog = false">取消</el-button>
          <el-button type="primary" @click="saveField">保存</el-button>
        </template>
      </el-dialog>
    </el-tab-pane>

    <el-tab-pane label="数据备份" name="backup">
      <div class="toolbar">
        <el-button type="primary" @click="backupNow">立即备份</el-button>
        <el-upload :show-file-list="false" accept=".db" :before-upload="restoreFromFile">
          <el-button>从文件恢复</el-button>
        </el-upload>
        <span class="tip">系统启动时及每隔 N 小时自动备份到 server/data/backups/，保留最近 30 份</span>
      </div>
      <el-alert v-if="backups.length" type="info" :closable="false" style="margin-bottom:10px"
        title="恢复会用备份覆盖当前全部数据。恢复前系统会自动把当前库存一份，恢复后需要重新登录。" />
      <el-table :data="backups" border size="small" v-loading="backupLoading">
        <template #empty>
          <el-empty :image-size="80" description="还没有备份记录">
            <el-button type="primary" @click="backupNow">立即备份</el-button>
          </el-empty>
        </template>
        <el-table-column prop="time" label="备份时间" width="200" />
        <el-table-column prop="name" label="文件名" />
        <el-table-column label="大小" width="110">
          <template #default="{ row }">{{ (row.size / 1024).toFixed(1) }} KB</template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button link type="primary" @click="downloadFile('/backups/download?file=' + encodeURIComponent(row.name), row.name)">下载</el-button>
            <el-button link type="danger" @click="restoreFromServer(row)">恢复</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-tab-pane>

    <el-tab-pane label="数据导入" name="import">
      <el-alert type="warning" :closable="false" title="商品批量导入"
        description="请先到「商品管理」下载导入模板，按模板填写后上传。相同名称的商品会更新资料；基准单位必须是「计量单位」中已存在的数量单位。期初库存请导入后使用「库存查询-调整」功能补录。" />
      <el-upload style="margin-top:14px" :show-file-list="false" accept=".xlsx,.xls" :before-upload="importProducts">
        <el-button type="primary">选择 Excel 文件导入</el-button>
      </el-upload>
    </el-tab-pane>

    <el-tab-pane v-if="!isSimple" label="扩展路线" name="extend">
      <el-card shadow="never">
        <h3>Windows 桌面端 / 手机端扩展</h3>
        <p style="color:#606266;line-height:1.8">
          本系统为前后端分离架构：后端提供 REST API，前端为 Vue3 页面，数据在 SQLite 单文件中。
          后续扩展：
        </p>
        <ul style="color:#606266;line-height:2">
          <li><b>Windows 桌面端</b>：用 Tauri（推荐，安装包仅几 MB）或 Electron 将现有前端包装为桌面应用，一键安装；数据文件不变。</li>
          <li><b>手机端</b>：先直接浏览器访问局域网地址（已支持）；需要真 App 时用 uni-app（Vue 语法）对接同一套 API 编译 Android/iOS。</li>
          <li>详细方案见项目 docs/architecture.md。</li>
        </ul>
      </el-card>
    </el-tab-pane>
  </el-tabs>
</template>

<script setup>
import { onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import * as XLSX from 'xlsx';
import api, { downloadFile } from '../api';
import { confirmAction, showError } from '../ui';
import { isSimple, mode, hasDemo, switchMode, setBusinessName } from '../mode';
import Warehouses from './Warehouses.vue';

const tab = ref('base');
const form = reactive({ business_name: '', auto_backup_hours: 6, access_password: '' });
const passwordDirty = ref(false);
const clearPassword = ref(false);
const passwordRequired = ref(false);
const uiMode = ref(mode.value);

const entities = [
  { value: 'product', label: '商品' },
  { value: 'supplier', label: '供应商' },
  { value: 'customer', label: '客户' },
  { value: 'purchase_order', label: '进货单' },
  { value: 'sales_order', label: '出货单' }
];
const fieldEntity = ref('product');
const fields = ref([]);
const fieldDialog = ref(false);
const optionsText = ref('');
const fieldForm = reactive({ id: null, entity: 'product', name: '', label: '', field_type: 'text', options: [], required: false });
const backups = ref([]);
const backupLoading = ref(false);

async function loadBase() {
  const s = await api.get('/settings');
  form.business_name = s.business_name;
  form.auto_backup_hours = s.auto_backup_hours;
  form.access_password = '';
  passwordRequired.value = s.password_required;
  passwordDirty.value = false;
  clearPassword.value = false;
  if (s.ui_mode !== uiMode.value) uiMode.value = s.ui_mode;
}
async function saveBase() {
  const body = { business_name: form.business_name, auto_backup_hours: form.auto_backup_hours };
  const pwChanged = passwordDirty.value || clearPassword.value;
  if (pwChanged) body.access_password = clearPassword.value ? '' : form.access_password;
  await api.put('/settings', body);
  setBusinessName(body.business_name);   // 左上角 logo / 标签页立即跟着变
  if (pwChanged) {
    passwordRequired.value = !!body.access_password;
    form.access_password = '';
    passwordDirty.value = false;
    clearPassword.value = false;
  }
  ElMessage.success(body.access_password !== undefined
    ? (body.access_password ? '已保存，访问密码已生效' : '已保存，访问密码已清除')
    : '已保存');
}
async function loadFields() { fields.value = await api.get('/custom-fields', { params: { entity: fieldEntity.value } }); }
function openField(row) {
  Object.assign(fieldForm, row
    ? { ...row, options: (() => { try { return JSON.parse(row.options || '[]'); } catch { return []; } })() }
    : { id: null, entity: fieldEntity.value, name: '', label: '', field_type: 'text', options: [], required: false });
  optionsText.value = fieldForm.options.join(',');
  fieldDialog.value = true;
}
async function saveField() {
  if (!fieldForm.label || !fieldForm.name) return ElMessage.warning('请填写显示名和字段名');
  fieldForm.options = optionsText.value ? optionsText.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];
  if (fieldForm.id) await api.put('/custom-fields/' + fieldForm.id, fieldForm);
  else await api.post('/custom-fields', fieldForm);
  ElMessage.success('已保存'); fieldDialog.value = false; loadFields();
}
async function removeField(row) {
  await api.delete('/custom-fields/' + row.id);
  ElMessage.success('已删除'); loadFields();
}
function fieldTypeText(t) { return { text: '文本', number: '数字', date: '日期', select: '下拉选项' }[t] || t; }

async function backupNow() {
  const r = await api.post('/backups');
  backups.value = r.list;
  ElMessage.success('备份完成');
}
async function loadBackups() { backups.value = await api.get('/backups'); }

// 恢复会用备份覆盖当前全部数据。服务端在覆盖前会先把当前库另存一份。
async function doRestore(payload, label) {
  const ok = await confirmAction(
    `确定用「${label}」恢复吗？\n\n当前全部数据会被覆盖。恢复前系统会自动把当前数据另存一份，恢复后需要重新登录。`,
    '恢复数据'
  );
  if (!ok) return;
  backupLoading.value = true;
  try {
    const r = await api.post('/backups/restore', payload);
    ElMessage.success(`已恢复，当前数据已另存为 ${r.safety}`);
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    showError(e, '恢复失败');
  } finally {
    backupLoading.value = false;
  }
}
function restoreFromServer(row) {
  return doRestore({ file: row.name }, row.name);
}
// 从本机选择备份文件恢复（换电脑、硬盘坏了的场景）
async function restoreFromFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    await doRestore({ data_base64: btoa(binary), filename: file.name }, file.name);
  } catch (e) {
    ElMessage.error('读取备份文件失败');
  }
  return false;   // 阻止 el-upload 自己发起上传
}

async function importProducts(file) {
  try {
    const wb = XLSX.read(await file.arrayBuffer());
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws);
    const rows2 = raw.map(r => ({
      name: r['名称'], category: r['分类'], spec: r['规格'], sku: r['编号'], barcode: r['条码'],
      base_unit: r['基准单位'], purchase_price: r['默认进价'], sale_price: r['默认售价'],
      stock_low: r['低库存阈值'], weight_per_base_kg: r['每基准单位重量kg'], remark: r['备注']
    })).filter(r => r.name);
    if (!rows2.length) { ElMessage.warning('没有识别到有效数据'); return false; }
    const res = await api.post('/import/products', { rows: rows2 });
    ElMessage.success(`导入完成：成功 ${res.ok} 条，跳过 ${res.skipped} 条`);
  } catch (e) { ElMessage.error('导入失败：' + (e.response?.data?.error || e.message)); }
  return false;
}

onMounted(() => { loadBase(); loadFields(); loadBackups(); });

// 模式切换：立即生效并持久化。若正停留在会被隐藏的页签上，先退回「基本设置」，
// 否则页签被移除后内容区会空掉。
watch(uiMode, async v => {
  if (v === mode.value) return;
  if (v === 'simple' && ['fields', 'extend'].includes(tab.value)) tab.value = 'base';
  try {
    await switchMode(v);
    ElMessage.success(v === 'simple' ? '已切换到简易模式' : '已切换到高级模式');
  } catch (e) {
    ElMessage.error('切换失败：' + (e.response?.data?.error || e.message));
  }
});
watch(mode, v => { if (uiMode.value !== v) uiMode.value = v; });

async function clearDemo() {
  await ElMessageBox.confirm('确定删除引导时添加的示例商品吗？已产生进出货记录的商品会自动保留。', '清除示例数据', { type: 'warning' });
  const r = await api.post('/demo/clear');
  ElMessage[r.kept ? 'warning' : 'success'](r.kept
    ? `已删除 ${r.removed} 个示例商品，${r.kept} 个因已有进出货记录被保留`
    : `已删除 ${r.removed} 个示例商品`);
  hasDemo.value = (await api.get('/settings')).has_demo;
}
</script>

<style scoped>.toolbar { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; } .tip { color: #909399; font-size: 12px; }</style>
