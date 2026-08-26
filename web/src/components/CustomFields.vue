<template>
  <el-form-item v-for="f in defs" :key="f.id" :label="f.label" :required="!!f.required">
    <el-input v-if="f.field_type === 'text'" v-model="model[f.name]" :placeholder="'请输入' + f.label" clearable />
    <el-input-number v-else-if="f.field_type === 'number'" v-model="model[f.name]" :controls="false" style="width:100%" />
    <el-date-picker v-else-if="f.field_type === 'date'" v-model="model[f.name]" type="date" value-format="YYYY-MM-DD" style="width:100%" />
    <el-select v-else-if="f.field_type === 'select'" v-model="model[f.name]" placeholder="请选择" clearable style="width:100%">
      <el-option v-for="o in optionsOf(f)" :key="o" :label="o" :value="o" />
    </el-select>
  </el-form-item>
</template>

<script setup>
import { ref, watch } from 'vue';
import api from '../api';

const props = defineProps({ entity: { type: String, required: true }, model: { type: Object, required: true } });
const defs = ref([]);

watch(() => props.entity, load, { immediate: true });
async function load() {
  if (!props.entity) return;
  defs.value = await api.get('/custom-fields', { params: { entity: props.entity } });
}
function optionsOf(f) { try { return JSON.parse(f.options || '[]'); } catch { return []; } }
</script>
