<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-button type="primary" @click="openDialog()">新增{{ label }}</el-button>
      <el-checkbox v-model="showInactive" @change="load">显示已停用</el-checkbox>
    </div>
    <el-table :data="rows" border v-loading="loading">
      <template #empty>
        <el-empty :image-size="80" :description="`还没有${label}`">
          <el-button type="primary" @click="openDialog()">新增{{ label }}</el-button>
        </el-empty>
      </template>
      <el-table-column prop="name" label="名称" width="220">
        <template #default="{ row }">
          {{ row.name }}
          <el-tag v-if="row.active === 0" size="small" type="info">已停用</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="contact" label="联系人" width="120" />
      <el-table-column prop="phone" label="电话" width="140" />
      <el-table-column prop="address" label="地址" show-overflow-tooltip />
      <el-table-column prop="remark" label="备注" show-overflow-tooltip />
      <el-table-column label="操作" width="150">
        <template #default="{ row }">
          <template v-if="row.active === 0">
            <el-button link type="success" @click="restore(row)">恢复</el-button>
          </template>
          <template v-else>
            <el-button link type="primary" @click="openDialog(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">停用</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="form.id ? '编辑' + label : '新增' + label" width="520px">
      <el-form label-width="80px">
        <el-form-item :label="label" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="联系人"><el-input v-model="form.contact" /></el-form-item>
        <el-form-item label="电话"><el-input v-model="form.phone" /></el-form-item>
        <el-form-item label="地址"><el-input v-model="form.address" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" /></el-form-item>
        <CustomFields v-if="!isSimple" :entity="entity" :model="form.custom_data" />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../api';
import { confirmAction, inactiveConflict, showError } from '../ui';
import CustomFields from '../components/CustomFields.vue';
import { isSimple } from '../mode';

const props = defineProps({ kind: { type: String, default: 'suppliers' } });
const entity = computed(() => props.kind === 'suppliers' ? 'supplier' : 'customer');
const label = computed(() => props.kind === 'suppliers' ? '供应商' : '客户');
const rows = ref([]);
const showInactive = ref(false);
const loading = ref(false);
const dialogVisible = ref(false);
const form = reactive({ id: null, name: '', contact: '', phone: '', address: '', remark: '', custom_data: {} });

async function load() {
  loading.value = true;
  try {
    rows.value = await api.get('/' + props.kind, {
      params: showInactive.value ? { includeInactive: '1' } : {}
    });
  } catch (e) {
    showError(e, label.value + '加载失败');
  } finally {
    loading.value = false;
  }
}
function openDialog(row) {
  Object.assign(form, row ? { ...row, custom_data: JSON.parse(row.custom_data || '{}') } : { id: null, name: '', contact: '', phone: '', address: '', remark: '', custom_data: {} });
  dialogVisible.value = true;
}
async function save() {
  if (!form.name) return ElMessage.warning('请输入名称');
  try {
    if (form.id) await api.put('/' + props.kind + '/' + form.id, form);
    else await api.post('/' + props.kind, form);
    ElMessage.success('已保存'); dialogVisible.value = false; load();
  } catch (e) {
    // 同名记录只是被停用了：直接引导恢复，而不是让用户以为系统坏了
    const c = inactiveConflict(e);
    if (c) {
      const ok = await confirmAction(`${c.message}。是否现在恢复它？`, '存在同名停用记录');
      if (ok) {
        try {
          await api.post(`/${props.kind}/${c.id}/restore`);
          ElMessage.success('已恢复'); dialogVisible.value = false; load();
        } catch (err) { showError(err, '恢复失败'); }
      }
      return;
    }
    showError(e, '保存失败');
  }
}
async function remove(row) {
  if (!(await confirmAction(`确定停用「${row.name}」吗？停用后可以在「显示已停用」里恢复。`, '停用' + label.value))) return;
  try {
    await api.delete('/' + props.kind + '/' + row.id);
    ElMessage.success('已停用'); load();
  } catch (e) { showError(e, '停用失败'); }
}
async function restore(row) {
  try {
    await api.post(`/${props.kind}/${row.id}/restore`);
    ElMessage.success('已恢复'); load();
  } catch (e) { showError(e, '恢复失败'); }
}
onMounted(load);
</script>

<style scoped>.toolbar { margin-bottom: 12px; }</style>
