<script setup lang="ts">
// 在 Provider 子树内捕获 useMessage()，注册到 utils/toast，
// 供非组件上下文（UiService.showToast 的 IPC 回调）弹出全局 toast。
import { useMessage } from 'naive-ui'
import { registerToast } from '../utils/toast'

registerToast(useMessage())
</script>

<template>
  <div style="display: none" />
</template>
