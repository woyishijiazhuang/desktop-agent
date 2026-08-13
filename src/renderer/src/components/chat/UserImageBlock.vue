<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NImage } from 'naive-ui'
import { mainClient } from '@renderer/utils/main-client'
import type { ImageContent } from '@earendil-works/pi-ai'

/**
 * 用户消息中的单张图片渲染：
 * - data 为 base64（内存态：发送后即时显示）→ 直接拼 data URL
 * - data 为 file: 引用（DB 态：会话重载后）→ 经 IPC 读盘为 data URL（模块级缓存，同图只读一次）
 * 使用 naive-ui NImage：点击缩略图打开内置全屏预览（缩放 / 旋转 / 下载工具栏）。
 */

/** data 是否为本地附件引用（file: 前缀）。 */
function isLocalFileRef(data: string): boolean {
  return data.startsWith('file:')
}

/** 从 file 引用提取相对 key。 */
function fileRefToKey(data: string): string {
  return data.slice('file:'.length)
}

/** 模块级缓存：fileKey → dataUrl。 */
const dataUrlCache = new Map<string, string>()

const props = defineProps<{ block: ImageContent }>()

const src = ref('')
const failed = ref(false)

onMounted(async () => {
  const data = props.block.data
  if (typeof data !== 'string') return
  if (isLocalFileRef(data)) {
    const key = fileRefToKey(data)
    const cached = dataUrlCache.get(key)
    if (cached) {
      src.value = cached
      return
    }
    try {
      const url = await mainClient.agent.getAttachmentDataUrl(key)
      dataUrlCache.set(key, url)
      src.value = url
    } catch {
      failed.value = true
    }
    return
  }
  src.value = `data:${props.block.mimeType};base64,${data}`
})
</script>

<template>
  <NImage v-if="src" class="user-image" :src="src" alt="" :img-props="{ title: '点击预览' }" />
  <span v-else-if="failed" class="user-image user-image--failed">（图片附件加载失败）</span>
</template>

<style scoped>
/* NImage 根节点是 div 包裹层（$attrs class 落在包裹层上），内部才是真正的 <img>；
   尺寸 / 圆角 / 光标需穿透到 img，否则按原图尺寸显示为巨大图。
   包裹层默认 display: inline-flex（naive 的 .n-image），会把图片变成行内元素、
   与文字左右混排；这里改回块级，让图片独占一行（图片在上、文字在下）。 */
.user-image {
  display: block;
}
.user-image :deep(img) {
  display: block;
  max-width: 320px;
  max-height: 240px;
  border-radius: var(--radius);
  object-fit: cover;
  margin-bottom: 4px;
  cursor: zoom-in;
}
.user-image--failed {
  font-size: 12px;
  color: var(--text-3);
  font-style: italic;
  padding: 4px 0;
}
</style>
