<template>
  <el-card shadow="never">
    <el-tabs v-model="tab">
      <el-tab-pane label="进货报表" name="purchase">
        <ReportPanel kind="purchase" />
      </el-tab-pane>
      <el-tab-pane label="出货报表" name="sales">
        <ReportPanel kind="sales" />
      </el-tab-pane>
      <el-tab-pane label="毛利报表" name="profit">
        <ProfitPanel />
      </el-tab-pane>
      <el-tab-pane label="库存报表" name="stock">
        <StockReportPanel />
      </el-tab-pane>
    </el-tabs>
  </el-card>
</template>

<script setup>
import { ref } from 'vue';
import ReportPanel from '../components/ReportPanel.vue';
import ProfitPanel from '../components/ProfitPanel.vue';
import StockReportPanel from '../components/StockReportPanel.vue';
const tab = ref('purchase');
</script>
