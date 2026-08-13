<script setup lang="ts">
// 标题栏已迁移为主进程独立 WebContentsView（见 src/renderer/header.html），
// 此布局仅承载路由内容，弹窗渲染在本视图内、被视图边界裁剪，无法再遮盖标题栏。
// 危险工具权限确认已改为内嵌在聊天消息流的工具卡片上（见 ToolCallCard 的「等待确认」态），
// 无需全局挂载弹窗：请求只出现在对应会话的对话流中，不再阻塞查看历史。
</script>

<template>
  <div class="app-layout">
    <main class="app-layout__main">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
}

.app-layout__main {
  flex: 1;
  overflow: hidden;
  display: flex;
  padding: 0;
}
</style>
