<script setup lang="ts">
import { h } from 'vue'
import { NDropdown, NButton, NIcon } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import {
  ArchiveOutline,
  ChatbubbleEllipsesOutline,
  CreateOutline,
  DownloadOutline,
  EllipsisHorizontal,
  PinOutline,
  TrashOutline
} from '@vicons/ionicons5'
import type { Session } from '@main/service/db-service'

/**
 * 单个会话行：图标 + 标题 + 置顶标记 + 状态点（待交互/生成中/失败）+ 相对时间 + ⋯ 菜单。
 * 菜单行为由父组件通过 action 事件处理（置顶/归档/导出/重命名/删除）。
 */
const props = defineProps<{
  session: Session
  active: boolean
  busy: boolean
  failed: boolean
  waiting: boolean
}>()

const emit = defineEmits<{
  select: []
  action: [key: string]
}>()

/** 三点菜单选项：置顶/归档/导出/重命名/删除（按会话状态动态生成）。 */
function buildMenuOptions(): DropdownOption[] {
  const s = props.session
  return [
    {
      label: s.pinned ? '取消置顶' : '置顶',
      key: 'pin',
      icon: () => h(NIcon, null, { default: () => h(PinOutline) })
    },
    {
      label: s.archived ? '取消归档' : '归档',
      key: 'archive',
      icon: () => h(NIcon, null, { default: () => h(ArchiveOutline) })
    },
    { type: 'divider', key: 'd-export' },
    {
      label: '导出为 Markdown',
      key: 'export-md',
      icon: () => h(NIcon, null, { default: () => h(DownloadOutline) })
    },
    {
      label: '导出为 JSON',
      key: 'export-json',
      icon: () => h(NIcon, null, { default: () => h(DownloadOutline) })
    },
    { type: 'divider', key: 'd-more' },
    {
      label: '重命名',
      key: 'rename',
      icon: () => h(NIcon, null, { default: () => h(CreateOutline) })
    },
    {
      label: '删除',
      key: 'delete',
      icon: () => h(NIcon, null, { default: () => h(TrashOutline) }),
      props: { style: 'color: var(--error)' }
    }
  ]
}

/** 简单的相对时间格式化（基于 last_active_at，unix ms）。 */
function formatTime(): string {
  const ts = props.session.lastActiveAt
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
</script>

<template>
  <div class="session-item" :class="{ 'session-item--active': active }" @click="emit('select')">
    <span class="session-item__bar" />
    <NIcon class="session-item__icon" :size="15">
      <ChatbubbleEllipsesOutline />
    </NIcon>
    <div class="session-item__main">
      <div class="session-item__name-row">
        <span class="session-item__name">{{ session.title }}</span>
        <NIcon
          v-if="session.pinned && !session.archived"
          class="session-item__pin"
          :size="12"
          title="已置顶"
        >
          <PinOutline />
        </NIcon>
        <!-- 状态点优先级：待交互（需用户处理，闪烁最醒目）> 生成中 > 上一轮失败 -->
        <span
          v-if="waiting"
          class="session-item__dot session-item__dot--waiting"
          title="等待确认/回答问题"
        />
        <span
          v-else-if="busy"
          class="session-item__dot session-item__dot--busy"
          title="生成中…"
        />
        <span
          v-else-if="failed"
          class="session-item__dot session-item__dot--error"
          title="上一轮生成失败"
        />
      </div>
      <div class="session-item__time">{{ formatTime() }}</div>
    </div>
    <NDropdown
      trigger="click"
      placement="bottom-end"
      :options="buildMenuOptions()"
      @select="(key: string) => emit('action', key)"
    >
      <NButton
        class="session-item__menu"
        circle
        quaternary
        size="tiny"
        title="更多操作"
        @click.stop
      >
        <NIcon :size="16"><EllipsisHorizontal /></NIcon>
      </NButton>
    </NDropdown>
  </div>
</template>

<style scoped>
.session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: var(--radius);
  cursor: pointer;
  position: relative;
  transition: background 0.1s ease;
}
.session-item:hover {
  background: var(--hover-bg);
}
.session-item--active {
  background: var(--primary-soft);
}
.session-item--active:hover {
  background: var(--primary-soft);
}
/* 活跃项左侧强调条 */
.session-item__bar {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: 0 2px 2px 0;
  background: var(--primary);
  opacity: 0;
  transition: opacity 0.1s ease;
}
.session-item--active .session-item__bar {
  opacity: 1;
}
.session-item__icon {
  color: var(--text-3);
  flex-shrink: 0;
}
.session-item--active .session-item__icon {
  color: var(--primary);
}
.session-item__main {
  flex: 1;
  min-width: 0;
}
.session-item__name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.session-item__name {
  font-size: 13px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.session-item--active .session-item__name {
  font-weight: 600;
  color: var(--primary-pressed);
}
/* 会话状态指示：busy 主色脉冲点（生成中），error 红点（上一轮失败），
   waiting 警示色闪烁点（有待用户处理的交互，如权限确认/计划审批/澄清问题） */
.session-item__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.session-item__dot--waiting {
  background: var(--warning);
  animation: session-status-blink 0.8s ease-in-out infinite;
}
.session-item__dot--busy {
  background: var(--primary);
  animation: session-status-pulse 1s ease-in-out infinite;
}
.session-item__dot--error {
  background: var(--error);
}
@keyframes session-status-blink {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.3;
    transform: scale(0.7);
  }
}
@keyframes session-status-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
.session-item__time {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}
/* 置顶小图标 */
.session-item__pin {
  color: var(--primary);
  flex-shrink: 0;
}
.session-item__menu {
  opacity: 0;
  flex-shrink: 0;
  transition: opacity 0.1s ease;
}
.session-item:hover .session-item__menu,
.session-item--active .session-item__menu {
  opacity: 1;
}
</style>
