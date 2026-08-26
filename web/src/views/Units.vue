<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-button type="primary" @click="openDialog()">新增单位</el-button>
      <span class="tip">换算说明：1 单位 = 换算倍数 × 基准单位（如 1 箱 = 24 件）；重量单位为可选的另一套体系</span>
    </div>
    <el-table :data="rows" border>
      <el-table-column prop="name" label="单位名称" width="140" />
      <el-table-column label="类型" width="100">
        <template #default="{ row }">{{ row.dimension === 'weight' ? '重量' : '数量' }}</template>
      </el-table-column>
      <el-table-column label="换算倍数" width="140">
        <template #default="{ row }">1 {{ row.name }} = {{ row.ratio }} 基准单位</template>
      </el-table-column>
      <el-table-column label="每单位重量(kg)" width="150">
        <template #default="{ row }">{{ row.weight_per ?? '—' }}</template>
      </el-table-column>
      <el-table-column prop="sort_order" label="排序" width="80" />
      <el-table-column label="操作" width="150">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDialog(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">停用</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="form.id ? '编辑单位' : '新增单位'" width="460px">
      <el-form label-width="110px">
        <el-form-item label="单位名称" required><el-input v-model="form.name" placeholder="如：件、箱、公斤" /></el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="form.dimension">
            <el-radio-button value="count">数量</el-radio-button>
            <el-radio-button value="weight">重量</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="换算倍数"><el-input-number v-model="form.ratio" :min="0.0001" :controls="false" style="width:100%" /></el-form-item>
        <el-form-item label="每单位重量kg"><el-input-number v-model="form.weight_per" :controls="false" style="width:100%" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="form.sort_order" :controls="false" style="width:100%" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';

const rows = ref([]);
const dialogVisible = ref(false);
const form = reactive({ id: null, name: '', dimension: 'count', ratio: 1, weight_per: null, sort_order: 0 });

async function load() { rows.value = await api.get('/units'); }
function openDialog(row) {
  Object.assign(form, row ? { ...row } : { id: null, name: '', dimension: 'count', ratio: 1, weight_per: null, sort_order: 0 });
  dialogVisible.value = true;
}
async function save() {
  if (!form.name) return ElMessage.warning('请输入单位名称');
  if (form.id) await api.put('/units/' + form.id, form);
  else await api.post('/units', form);
  ElMessage.success('已保存'); dialogVisible.value = false; load();
}
async function remove(row) {
  await ElMessageBox.confirm(`确定停用单位「${row.name}」吗？`, '提示', { type: 'warning' });
  await api.delete('/units/' + row.id);
  ElMessage.success('已停用'); load();
}
onMounted(load);
</script>

<style scoped>.toolbar { margin-bottom: 12px; display: flex; align-items: center; gap: 12px; } .tip { color: #909399; font-size: 12px; }</style>
