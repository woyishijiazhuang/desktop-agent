<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NCard, NButton, NEmpty, NInput, useMessage } from 'naive-ui'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import { mainClient } from '@renderer/utils/main-client'
import WebSearchCard from './WebSearchCard.vue'
import ToolSwitches from './ToolSwitches.vue'

/** 有独立配置卡片（开关 + 配置合并）的工具：不在通用开关列表中重复出现。 */
const CONFIGURED_TOOLS = new Set(['web_search', 'find_skill'])
/** 技能域工具：开关展示在「技能」页，不在工具页重复。 */
const SKILL_TOOLS = new Set(['find_skill', 'install_skill', 'read_skill'])
/** 记忆域工具：开关展示在「记忆」页，不在工具页重复。 */
const MEMORY_TOOLS = new Set(['list_memories', 'add_memory', 'update_memory', 'delete_memory'])
/** 知识库域工具：开关展示在「知识库」页（知识库工具卡片），不在工具页重复。 */
const KB_TOOLS = new Set(['search_knowledge'])

const settings = useSettingsStore()
const message = useMessage()

/** 通用工具列表（排除独立卡片与技能/记忆/知识库域工具）。 */
const generalTools = computed(() =>
  settings.tools.filter(
    (t) =>
      !CONFIGURED_TOOLS.has(t.name) &&
      !SKILL_TOOLS.has(t.name) &&
      !MEMORY_TOOLS.has(t.name) &&
      !KB_TOOLS.has(t.name)
  )
)

/** bash 持久白名单：权限弹窗点「总是允许」的命令列表，可在此查看与移除。 */
const bashAllowlist = ref<string[]>([])
onMounted(async () => {
  bashAllowlist.value = await mainClient.agent.listBashAllowlist()
})

async function removeAllowlistRule(command: string): Promise<void> {
  await mainClient.agent.removeBashAllowlist(command)
  bashAllowlist.value = bashAllowlist.value.filter((c) => c !== command)
  message.success('已从白名单移除')
}

/** 环境变量草稿：编辑本地值，点保存才提交。 */
const envRows = ref<{ key: string; value: string }[]>([])
watch(
  () => settings.agentEnv,
  (env) => {
    envRows.value = Object.entries(env).map(([key, value]) => ({ key, value }))
  },
  { immediate: true }
)

function addEnvRow(): void {
  envRows.value.push({ key: '', value: '' })
}

function removeEnvRow(i: number): void {
  envRows.value.splice(i, 1)
}

async function saveEnv(): Promise<void> {
  const env: Record<string, string> = {}
  for (const r of envRows.value) {
    const key = r.key.trim()
    if (!key) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      message.error(`环境变量名不合法：${key}`)
      return
    }
    env[key] = r.value
  }
  await settings.saveAgentEnv(env)
  message.success('环境变量已保存，下一轮命令生效')
}

/** 重新读取用户 shell 环境（.zshrc/.bashrc），修改后无需重启应用。 */
async function refreshShellEnv(): Promise<void> {
  try {
    const r = await mainClient.agent.refreshShellEnv()
    if (r.ok) {
      message.success(`已重新读取 shell 环境（${r.count} 个变量），下一轮命令生效`)
    } else {
      message.error(r.error ?? '重新读取 shell 环境失败')
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : '重新读取 shell 环境失败')
  }
}
</script>

<template>
  <div>
    <NCard size="small" class="settings-card">
      <template #header>
        <span>工具</span>
      </template>
      <p class="settings-card__desc">
        控制 Agent 可调用的文件与系统工具。关闭后 Agent
        将无法使用该工具。修改后对当前会话下一轮生效。
        技能、记忆与知识库相关工具请分别在「技能」「记忆」「知识库」页管理。
      </p>
      <ToolSwitches :tools="generalTools" />
    </NCard>

    <NCard size="small" class="settings-card">
      <template #header>
        <span>命令白名单</span>
      </template>
      <p class="settings-card__desc">
        在权限确认弹窗中点击「总是允许」的命令会累积在此，命中后执行免确认。破坏性命令（删除、强制推送、sudo
        等）不受白名单影响，仍会强制确认。移除后该命令恢复为每次询问。
      </p>
      <div v-if="bashAllowlist.length === 0" class="allowlist-empty">
        <NEmpty description="暂无白名单命令" :show-icon="false" size="small" />
      </div>
      <div v-else class="allowlist">
        <div v-for="cmd in bashAllowlist" :key="cmd" class="allowlist__item">
          <code class="allowlist__cmd">{{ cmd }}</code>
          <NButton size="tiny" tertiary type="error" @click="removeAllowlistRule(cmd)"
            >移除</NButton
          >
        </div>
      </div>
    </NCard>

    <!-- 网页搜索：开关与 Key 配置合并在同一卡片 -->
    <WebSearchCard class="settings-card" />

    <NCard size="small" class="settings-card">
      <template #header>
        <span>环境变量</span>
      </template>
      <p class="settings-card__desc">
        Agent 执行命令（bash）时使用的额外环境变量。生效优先级：应用自身环境 &lt; 用户 shell
        环境（自动读取 .zshrc / .bashrc）&lt; 此处配置。修改 .zshrc / .bashrc
        后点「重新读取」即可生效，无需重启应用；此处配置保存后立即生效。
      </p>
      <div v-if="envRows.length === 0" class="env-empty">暂无自定义环境变量。</div>
      <div v-else class="env-list">
        <div v-for="(row, i) in envRows" :key="i" class="env-row">
          <NInput
            v-model:value="row.key"
            placeholder="变量名，如 AGENT_BROWSER_EXECUTABLE_PATH"
            class="env-row__key"
            size="small"
            spellcheck="false"
          />
          <NInput
            v-model:value="row.value"
            placeholder="值，如 /path/to/app"
            class="env-row__value"
            size="small"
            spellcheck="false"
          />
          <NButton size="small" tertiary quaternary @click="removeEnvRow(i)">移除</NButton>
        </div>
      </div>
      <div class="env-actions">
        <NButton size="small" tertiary @click="addEnvRow">添加变量</NButton>
        <NButton size="small" tertiary @click="refreshShellEnv">重新读取 shell 环境</NButton>
        <NButton size="small" type="primary" @click="saveEnv">保存</NButton>
      </div>
    </NCard>
  </div>
</template>

<style scoped>
/* 卡片间距（子组件根节点带本组件 scope，可命中） */
.settings-card {
  margin-bottom: 16px;
}

.settings-card__desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-3);
}

/* 命令白名单列表 */
.allowlist-empty {
  padding: 8px 0;
}
.allowlist {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.allowlist__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.allowlist__cmd {
  font-size: 12px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 工作目录 */
.workdir__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

/* 环境变量 */
.env-empty {
  padding: 8px 0;
  font-size: 13px;
  color: var(--text-3);
}
.env-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.env-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.env-row__key {
  flex: 2;
}
.env-row__value {
  flex: 3;
}
.env-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
