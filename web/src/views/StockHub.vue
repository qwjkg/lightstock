<template>
  <!-- 简易模式：库存查询 + 进出记录 合成一页两个页签，减少一个一级菜单 -->
  <el-tabs v-if="isSimple" v-model="tab">
    <el-tab-pane label="库存查询" name="stock"><Stock /></el-tab-pane>
    <el-tab-pane label="进出记录" name="ledger"><Ledger /></el-tab-pane>
  </el-tabs>
  <Stock v-else />
</template>

<script setup>
import { ref } from 'vue';
import Stock from './Stock.vue';
import Ledger from './Ledger.vue';
import { isSimple } from '../mode';

const tab = ref('stock');
</script>