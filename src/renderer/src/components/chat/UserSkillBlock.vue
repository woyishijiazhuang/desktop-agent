<script setup lang="ts">
import { ExtensionPuzzleOutline } from '@vicons/ionicons5'
import CollapsibleBlock from './CollapsibleBlock.vue'

/**
 * 用户消息中的技能内容块（type=text + skill_name）：
 * 展示为「技能名」卡片，点击展开 SKILL.md 全文（main 侧落库时填充）。
 * 技能全文独立成块后不混入用户正文，正文只显示用户输入。
 */
defineProps<{ name: string; text: string }>()
</script>

<template>
  <CollapsibleBlock
    :icon="ExtensionPuzzleOutline"
    :name="name"
    :text="text"
    variant="accent"
    collapsed-action="查看技能说明"
    empty-action="技能已附加"
    empty-hint="技能说明已随消息发送给模型。"
  />
</template>
