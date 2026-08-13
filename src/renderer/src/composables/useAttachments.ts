import { ref, type Ref } from 'vue'
import type { MessageApi } from 'naive-ui'
import type { ComposerAttachment } from '@renderer/store/useChatStore'
import { mainClient } from '@renderer/utils/main-client'

/** 附件大小上限（与主进程一致）。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_TEXT_BYTES = 256 * 1024
const MAX_DOC_BYTES = 20 * 1024 * 1024

/** 聊天中支持解析的文档扩展名（与主进程 doc-parser 保持一致）。 */
const DOC_EXTS = ['docx', 'pdf', 'xlsx', 'pptx', 'csv']

function isDocumentName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return DOC_EXTS.includes(ext)
}

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `att-${Date.now().toString(36)}-${uidCounter}`
}

/**
 * 附件管理 composable：收集待发送的图片 / 纯文本 / 文档附件。
 * - 图片转 dataURL（base64），文档经主进程 mdize 解析为 Markdown，剪贴板截图兜底走主进程
 * - 支持拖拽 / 粘贴 / 文件选择三种收集入口
 * - 图片输入受模型多模态能力约束（imageDisabled 由调用方实时传入）
 */
export function useAttachments(options: {
  /** 当前模型是否不支持图片（返回布尔，随模型切换实时生效）。 */
  imageDisabled: () => boolean
  message: MessageApi
}): {
  attachments: Ref<ComposerAttachment[]>
  dragOver: Ref<boolean>
  onDrop: (e: DragEvent) => void
  onPaste: (e: ClipboardEvent) => void
  onFileInputChange: (e: Event) => void
  removeAttachment: (id: string) => void
} {
  /** 待发送附件（图片 / 纯文本），发送成功或移除后清空。 */
  const attachments = ref<ComposerAttachment[]>([])
  /** 拖拽悬停高亮。 */
  const dragOver = ref(false)

  /** 从 File 对象读取为附件：图片转 dataURL，文档走主进程解析，文本直读。 */
  function addFile(file: File): void {
    const isImage = file.type.startsWith('image/')
    if (isImage) {
      // 当前模型不支持多模态：禁止图片输入（未选模型不限制）
      if (options.imageDisabled()) {
        options.message.warning('当前模型不支持图片，请切换支持多模态的模型')
        return
      }
      if (file.size > MAX_IMAGE_BYTES) {
        options.message.error(`图片过大（超过 10MB 上限）：${file.name}`)
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const base64 = dataUrl.split(',')[1] ?? ''
        attachments.value.push({
          id: uid(),
          kind: 'image',
          name: file.name,
          size: file.size,
          mimeType: file.type || 'image/png',
          base64,
          dataUrl
        })
      }
      reader.onerror = () => options.message.error(`读取图片失败：${file.name}`)
      reader.readAsDataURL(file)
      return
    }
    // 文档（docx/pdf/xlsx/pptx/csv）：主进程 mdize 解析为 Markdown 后作为文本附件
    if (isDocumentName(file.name)) {
      void addDocument(file)
      return
    }
    if (file.size > MAX_TEXT_BYTES) {
      options.message.error(`文本文件过大（超过 256KB 上限）：${file.name}`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const content = reader.result as string
      if (content.includes('\u0000')) {
        options.message.error('不支持的二进制文件，仅支持图片、文档与纯文本文件')
        return
      }
      attachments.value.push({
        id: uid(),
        kind: 'file',
        name: file.name,
        size: file.size,
        text: content
      })
    }
    reader.onerror = () => options.message.error(`读取文件失败：${file.name}`)
    reader.readAsText(file)
  }

  /** 文档附件：读字节 → 主进程解析为文本 → 作为文件附件加入（超长已由主进程截断）。 */
  async function addDocument(file: File): Promise<void> {
    if (file.size > MAX_DOC_BYTES) {
      options.message.error(`文档过大（超过 20MB 上限）：${file.name}`)
      return
    }
    try {
      const buffer = new Uint8Array(await file.arrayBuffer())
      const text = await mainClient.agent.parseDocumentFile(buffer, file.name)
      if (!text.trim()) {
        options.message.error(`未能从「${file.name}」中提取到文本内容`)
        return
      }
      attachments.value.push({
        id: uid(),
        kind: 'file',
        name: file.name,
        size: file.size,
        text
      })
    } catch (err) {
      options.message.error(
        `解析文档失败（${file.name}）：${err instanceof Error ? err.message : err}`
      )
    }
  }

  /** 剪贴板截图兜底：文件型剪贴板读不到时经主进程读。 */
  async function addClipboardImage(): Promise<void> {
    // 当前模型不支持多模态：禁止粘贴截图
    if (options.imageDisabled()) {
      options.message.warning('当前模型不支持图片，请切换支持多模态的模型')
      return
    }
    try {
      const img = await mainClient.agent.readClipboardImage()
      if (!img) return
      attachments.value.push({
        id: uid(),
        kind: 'image',
        name: '截图.png',
        size: 0,
        mimeType: img.mimeType,
        base64: img.base64,
        dataUrl: `data:${img.mimeType};base64,${img.base64}`
      })
    } catch {
      // 剪贴板无图或读取失败：静默忽略
    }
  }

  function onDrop(e: DragEvent): void {
    dragOver.value = false
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    e.preventDefault()
    for (const f of Array.from(files)) addFile(f)
  }

  function onPaste(e: ClipboardEvent): void {
    const clipboardData = e.clipboardData
    if (!clipboardData) return
    // 1. 从文件管理器复制的文件 → 直接读取
    const files = Array.from(clipboardData.files)
    if (files.length > 0) {
      e.preventDefault()
      for (const f of files) addFile(f)
      return
    }
    // 2. 截图复制（item 为 image 类型，可取 File）
    const imageItems = Array.from(clipboardData.items).filter(
      (i) => i.kind === 'file' && i.type.startsWith('image/')
    )
    for (const item of imageItems) {
      const f = item.getAsFile()
      if (f) {
        e.preventDefault()
        addFile(f)
        return
      }
    }
    // 3. 兜底：某些平台 item 无 file，主进程读系统剪贴板
    if (Array.from(clipboardData.items).some((i) => i.type.startsWith('image/'))) {
      e.preventDefault()
      void addClipboardImage()
    }
  }

  function onFileInputChange(e: Event): void {
    const input = e.target as HTMLInputElement
    for (const f of Array.from(input.files ?? [])) addFile(f)
    input.value = ''
  }

  function removeAttachment(id: string): void {
    attachments.value = attachments.value.filter((a) => a.id !== id)
  }

  return {
    attachments,
    dragOver,
    onDrop,
    onPaste,
    onFileInputChange,
    removeAttachment
  }
}
