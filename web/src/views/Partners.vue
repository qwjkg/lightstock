<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-button type="primary" @click="openDialog()">新增{{ label }}</el-button>
    </div>
    <el-table :data="rows" border>
      <el-table-column prop="name" label="名称" width="200" />
      <el-table-column prop="contact" label="联系人" width="120" />
      <el-table-column prop="phone" label="电话" width="140" />
      <el-table-column prop="address" label="地址" show-overflow-tooltip />
      <el-table-column prop="remark" label="备注" show-overflow-tooltip />
      <el-table-column label="操作" width="150">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDialog(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">停用</el-button>
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
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import CustomFields from '../components/CustomFields.vue';
import { isSimple } from '../mode';

const props = defineProps({ kind: { type: String, default: 'suppliers' } });
const entity = computed(() => props.kind === 'suppliers' ? 'supplier' : 'customer');
const label = computed(() => props.kind === 'suppliers' ? '供应商' : '客户');
const rows = ref([]);
const dialogVisible = ref(false);
const form = reactive({ id: null, name: '', contact: '', phone: '', address: '', remark: '', custom_data: {} });

async function load() { rows.value = await api.get('/' + props.kind); }
function openDialog(row) {
  Object.assign(form, row ? { ...row, custom_data: JSON.parse(row.custom_data || '{}') } : { id: null, name: '', contact: '', phone: '', address: '', remark: '', custom_data: {} });
  dialogVisible.value = true;
}
async function save() {
  if (!form.name) return ElMessage.warning('请输入名称');
  if (form.id) await api.put('/' + props.kind + '/' + form.id, form);
  else await api.post('/' + props.kind, form);
  ElMessage.success('已保存'); dialogVisible.value = false; load();
}
async function remove(row) {
  await ElMessageBox.confirm(`确定停用「${row.name}」吗？`, '提示', { type: 'warning' });
  await api.delete('/' + props.kind + '/' + row.id);
  ElMessage.success('已停用'); load();
}
onMounted(load);
</script>

<style scoped>.toolbar { margin-bottom: 12px; }</style>
