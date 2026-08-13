<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NCollapse, NCollapseItem, NScrollbar, NIcon } from 'naive-ui'
import { BulbOutline, SyncOutline } from '@vicons/ionicons5'
import { useStickToBottomPause } from '@renderer/composables/useStickToBottomPause'

/**
 * 思考过程块（thinking）：跟随流式状态自动展开/收起。
 * - live（该块仍在流式增长）：自动展开，标题显示「思考中…」+ 旋转图标，内容随生成自动滚底。
 * - 思考结束（live 变 false / 历史消息）：自动收起为一行「思考过程」，用户可手动展开。
 * 纯文本展示（不渲染 Markdown，避免推理内容注入）；超长用 NScrollbar 限定高度。
 */
const props = defineProps<{ thinking: string; live?: boolean }>()

const pauseStick = useStickToBottomPause()

const expanded = ref(false)

// 受控折叠：live 切换驱动自动展开/收起；用户手动点击仍走 update:expanded-names。
// isProgrammatic 标记 live 驱动的程序式变更，使 onUpdateNames 能区分「用户点击」与
// 「live 自动收起」——仅前者需暂停粘底（自动收起是流式结束的副产物，不应触发）。
let isProgrammatic = false
watch(
  () => props.live,
  (live) => {
    isProgrammatic = true
    expanded.value = !!live
    void nextTick(() => {
      isProgrammatic = false
    })
  },
  { immediate: true }
)

const expandedNames = computed(() => (expanded.value ? ['reasoning'] : []))

function onUpdateNames(names: Array<string | number>): void {
  if (!isProgrammatic) {
    // 用户手动展开/收起：解除粘底锁定，避免高度变化被当作流式增长强制滚底而闪烁
    pauseStick?.()
  }
  expanded.value = names.includes('reasoning')
}

const headerText = computed(() => (props.live ? '思考中…' : '思考过程'))

/** 自动滚底：仅思考中（live）跟随内容增长滚到底部，方便连续阅读。
 *  behavior 用 'auto' 而非 'smooth'：live 时内容每个 token 都在变，smooth 动画
 *  永远追不上增量，反而产生持续的追赶式滚动；auto 直接跳到当前底部。 */
const scrollbarRef = ref<InstanceType<typeof NScrollbar> | null>(null)
watch(
  () => props.thinking,
  () => {
    if (props.live) {
      void nextTick(() => {
        scrollbarRef.value?.scrollTo({ top: 1e9, behavior: 'auto' })
      })
    }
  }
)
</script>

<template>
  <NCollapse
    class="reasoning"
    :expanded-names="expandedNames"
    display-directive="show"
    @update:expanded-names="onUpdateNames"
  >
    <NCollapseItem name="reasoning">
      <template #header>
        <span class="reasoning__header">
          <NIcon :size="14" class="reasoning__icon" :class="{ 'reasoning__icon--spin': live }">
            <SyncOutline v-if="live" />
            <BulbOutline v-else />
          </NIcon>
          {{ headerText }}
        </span>
      </template>
      <NScrollbar ref="scrollbarRef" class="reasoning__scroll" :style="{ maxHeight: '240px' }">
        <div class="reasoning__body">{{ props.thinking }}</div>
      </NScrollbar>
    </NCollapseItem>
  </NCollapse>
</template>

<style scoped>
.reasoning {
  margin: 4px 0;
}
.reasoning__header {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--text-2);
}
.reasoning__icon {
  color: var(--primary);
  flex-shrink: 0;
}
.reasoning__icon--spin {
  animation: reasoning-spin 1s linear infinite;
}
@keyframes reasoning-spin {
  to {
    transform: rotate(360deg);
  }
}
.reasoning__scroll {
  border-left: 2px solid var(--primary-soft);
  border-radius: 0 6px 6px 0;
  background: var(--bg-soft);
}
.reasoning__body {
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
}
</style>
