<script setup lang="ts">
import McpServersCard from './McpServersCard.vue'
</script>

<template>
  <div>
    <!-- MCP 服务器 -->
    <McpServersCard class="settings-card" />
  </div>
</template>

<style scoped>
/* 卡片间距（子组件根节点带本组件 scope，可命中） */
.settings-card {
  margin-bottom: 16px;
}
</style>
