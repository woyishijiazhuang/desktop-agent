<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  NModal,
  NInput,
  NButton,
  NRadioGroup,
  NRadioButton,
  NSwitch,
  NSpace,
  useMessage
} from 'naive-ui'
import { mainClient } from '@renderer/utils/main-client'
import type { CreateMcpServerParams } from '@main/service/db-service'
import type { McpServerConfig } from '@main/agent/mcp/types'

/** MCP server 新增 / 编辑弹窗。 */
const props = defineProps<{ show: boolean; server: McpServerConfig | null }>()
const emit = defineEmits<{ 'update:show': [boolean]; saved: [] }>()
const message = useMessage()

const name = ref('')
const transport = ref<'stdio' | 'http'>('stdio')
const command = ref('')
/** 参数：每行一个（textarea 编辑，保存时按行拆分）。 */
const argsText = ref('')
/** 环境变量：每行 KEY=VALUE。 */
const envText = ref('')
const url = ref('')
const enabled = ref(true)

const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; text: string } | null>(null)

// 打开弹窗时按编辑目标初始化表单
watch(
  () => props.show,
  (show) => {
    if (!show) return
    const s = props.server
    name.value = s?.name ?? ''
    transport.value = s?.transport ?? 'stdio'
    command.value = s?.command ?? ''
    argsText.value = s?.args.join('\n') ?? ''
    envText.value = s
      ? Object.entries(s.env)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')
      : ''
    url.value = s?.url ?? ''
    enabled.value = s?.enabled ?? true
    testResult.value = null
  }
)

/** 表单 → 创建/更新参数。 */
function buildParams(): CreateMcpServerParams {
  const args = argsText.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const env: Record<string, string> = {}
  for (const line of envText.value.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return {
    name: name.value.trim(),
    transport: transport.value,
    command: command.value.trim(),
    args,
    env,
    url: url.value.trim(),
    enabled: enabled.value
  }
}

/** 校验表单，返回错误文案（null = 通过）。 */
function validate(): string | null {
  if (!name.value.trim()) return '请填写服务器名称'
  if (transport.value === 'http') {
    if (!url.value.trim()) return 'HTTP 传输需要填写 server URL'
  } else if (!command.value.trim()) {
    return 'stdio 传输需要填写启动命令'
  }
  return null
}

async function onTest(): Promise<void> {
  const err = validate()
  if (err) {
    message.error(err)
    return
  }
  testing.value = true
  testResult.value = null
  try {
    const r = await mainClient.mcp.testConnection(buildParams())
    testResult.value = r.ok
      ? { ok: true, text: `连接成功，发现 ${r.tools.length} 个工具` }
      : { ok: false, text: `连接失败：${r.error}` }
  } catch (e) {
    testResult.value = { ok: false, text: `连接失败：${e instanceof Error ? e.message : e}` }
  } finally {
    testing.value = false
  }
}

async function onSave(): Promise<void> {
  const err = validate()
  if (err) {
    message.error(err)
    return
  }
  saving.value = true
  try {
    const params = buildParams()
    if (props.server) {
      await mainClient.mcp.updateServer(props.server.id, params)
    } else {
      await mainClient.mcp.createServer(params)
    }
    message.success(props.server ? '已保存' : '已添加')
    emit('saved')
    emit('update:show', false)
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="server ? '编辑 MCP 服务器' : '添加 MCP 服务器'"
    style="width: 520px"
    :mask-closable="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="mcp-form">
      <label class="mcp-form__label">名称</label>
      <NInput v-model:value="name" placeholder="如：文件系统 / 数据库" :maxlength="40" />

      <label class="mcp-form__label">传输方式</label>
      <NRadioGroup v-model:value="transport" class="mcp-form__transport">
        <NRadioButton value="stdio">stdio（本地进程）</NRadioButton>
        <NRadioButton value="http">HTTP/SSE（远程 URL）</NRadioButton>
      </NRadioGroup>

      <template v-if="transport === 'stdio'">
        <label class="mcp-form__label">命令</label>
        <NInput v-model:value="command" placeholder="如：npx / python / node" />
        <label class="mcp-form__label">参数（每行一个）</label>
        <NInput
          v-model:value="argsText"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 4 }"
          placeholder="如：-y&#10;@modelcontextprotocol/server-filesystem&#10;/Users/me/Documents"
        />
        <label class="mcp-form__label">环境变量（可选，每行 KEY=VALUE）</label>
        <NInput
          v-model:value="envText"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 4 }"
          placeholder="API_KEY=xxx&#10;PORT=8080"
        />
      </template>

      <template v-else>
        <label class="mcp-form__label">Server URL</label>
        <NInput v-model:value="url" placeholder="如：https://mcp.example.com/mcp" />
      </template>

      <label class="mcp-form__label">启用</label>
      <div class="mcp-form__enable">
        <NSwitch v-model:value="enabled" />
        <span class="mcp-form__enable-hint">关闭后该服务器的工具不会被 Agent 使用</span>
      </div>

      <div v-if="testResult" class="mcp-form__test" :class="testResult.ok ? 'is-ok' : 'is-err'">
        {{ testResult.text }}
      </div>
    </div>

    <template #action>
      <NSpace justify="space-between" style="width: 100%">
        <NButton :loading="testing" @click="onTest">测试连接</NButton>
        <NSpace :size="8">
          <NButton @click="emit('update:show', false)">取消</NButton>
          <NButton type="primary" :loading="saving" @click="onSave">保存</NButton>
        </NSpace>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.mcp-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mcp-form__label {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-3);
}
.mcp-form__transport {
  width: 100%;
}
.mcp-form__enable {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.mcp-form__enable-hint {
  font-size: 12px;
  color: var(--text-3);
}
.mcp-form__test {
  margin-top: 12px;
  padding: 8px 10px;
  border-radius: var(--radius);
  font-size: 12px;
  word-break: break-all;
}
.mcp-form__test.is-ok {
  background: var(--success-soft);
  color: var(--success);
}
.mcp-form__test.is-err {
  background: var(--error-soft);
  color: var(--error);
}
</style>
