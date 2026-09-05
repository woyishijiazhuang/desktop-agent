<script setup lang="ts">
// 预设主题色色板选择器：浅色 primary 作色块预览，选中态描边高亮。
// 供设置页全局默认主题色与工作区卡片自定义主题色复用。
import { THEME_COLOR_KEYS, THEME_PALETTES, type ThemeColorKey } from '@main/service/theme-palettes'

defineProps<{
  /** 当前选中主题色 key；null = 跟随全局默认（仅 allow-default 时可选）。 */
  modelValue: string | null
  /** 是否提供「跟随默认」选项（工作区自定义场景）。 */
  allowDefault?: boolean
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string | null): void }>()

const LABELS: Record<ThemeColorKey, string> = {
  violet: '紫罗兰',
  blue: '蓝色',
  cyan: '青色',
  teal: '青绿',
  emerald: '翠绿',
  amber: '琥珀',
  orange: '橙色',
  rose: '玫红',
  pink: '粉色',
  indigo: '靛蓝'
}
</script>

<template>
  <div class="theme-color-picker">
    <button
      v-if="allowDefault"
      class="swatch swatch--default"
      :class="{ 'swatch--active': modelValue === null }"
      title="跟随全局默认"
      @click="emit('update:modelValue', null)"
    >
      随
    </button>
    <button
      v-for="key in THEME_COLOR_KEYS"
      :key="key"
      class="swatch"
      :class="{ 'swatch--active': modelValue === key }"
      :style="{ background: THEME_PALETTES[key].light.primary }"
      :title="LABELS[key]"
      @click="emit('update:modelValue', key)"
    />
  </div>
</template>

<style scoped>
.theme-color-picker {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.swatch {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}
.swatch:hover {
  border-color: var(--text-3);
}
.swatch--active {
  border-color: var(--text-1);
  box-shadow: 0 0 0 2px var(--bg-soft);
}
/* 「跟随默认」选项：渐变示意全局与自定义的差异 */
.swatch--default {
  background: linear-gradient(135deg, #7c3aed 50%, #a78bfa 50%);
  font-size: 10px;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
