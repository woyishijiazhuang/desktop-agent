<script setup lang="ts">
import { DocumentTextOutline } from '@vicons/ionicons5'
import CollapsibleBlock from './CollapsibleBlock.vue'

/**
 * 用户消息中的文件内容块（type=text + file_name）：
 * 默认折叠为「文件名 + 查看内容」卡片，点击展开解析后的文本（max-height 滚动）。
 * 文件内容独立成块后不再混入用户正文，正文只显示用户输入。
 */
defineProps<{ name: string; text: string }>()
</script>

<template>
  <CollapsibleBlock :icon="DocumentTextOutline" :name="name" :text="text" />
</template>
