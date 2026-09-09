<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NInput, NSwitch, NTag, useMessage } from 'naive-ui'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import { mainClient } from '@renderer/utils/main-client'
import type { SandboxPlatformStatus } from '@main/agent/sandbox'

/** 沙箱各列表分类的配置（统一编辑区渲染）。 */
interface ListCat {
  id: 'writable' | 'denyRead' | 'network'
  label: string
  hint: string
  placeholder: string
}

const settings = useSettingsStore()
const message = useMessage()

const cats: ListCat[] = [
  {
    id: 'writable',
    label: '可写目录',
    hint: '命令与文件工具（write_file / edit_file / download 落盘）只能写入「系统临时目录 + 工作区 + 以下目录」。系统临时目录（macOS TMPDIR、Linux /tmp、Windows %TEMP%）默认可写无需登记；工作区为发起命令的会话所绑定的目录，切换工作区后新会话自动跟随；这里追加工作区外的授权目录（例如全局包缓存 ~/.npm）。',
    placeholder: '绝对路径，如 /Users/me/.npm'
  },
  {
    id: 'denyRead',
    label: '禁止读取的目录',
    hint: '默认全局可读，此处将目录从可读范围中剔除（保护密钥、敏感文件）。read_file 直接读取、grep 搜索与文件写入命中该目录时会被拒绝。',
    placeholder: '绝对路径，如 /Users/me/.ssh'
  },
  {
    id: 'network',
    label: '网络白名单',
    hint: '沙箱内命令的外网访问按域名放行（支持 *.example.com 与 :port 后缀）。留空 = 禁止全部外网；未配置过时默认含常用代码托管与包注册站点。',
    placeholder: '域名，如 registry.npmjs.org'
  }
]

/** 各分类草稿（编辑本地，点保存提交）。 */
const drafts = ref<Record<string, string[]>>({ writable: [], denyRead: [], network: [] })
/** 各分类「新增」输入框内容。 */
const adding = ref<Record<string, string>>({ writable: '', denyRead: '', network: '' })

// store 值变化（初始化加载/多窗口同步）时同步到草稿
watch(
  () => [
    settings.sandboxWritableRoots,
    settings.sandboxDenyReadRoots,
    settings.sandboxNetworkAllowlist
  ],
  ([w, d, n]) => {
    drafts.value.writable = [...w]
    drafts.value.denyRead = [...d]
    drafts.value.network = [...n]
  },
  { immediate: true }
)

async function toggleEnabled(v: boolean): Promise<void> {
  try {
    await settings.saveSandboxEnabled(v)
    message.success(v ? '沙箱已开启，新启动的命令将被隔离' : '沙箱已关闭')
    // 刷新平台状态卡片，使「当前沙箱已开启/未开启」文字同步更新
    void loadPlatformStatus()
  } catch (err) {
    message.error(err instanceof Error ? err.message : '保存失败')
  }
}

function addRow(cat: ListCat): void {
  const val = adding.value[cat.id].trim()
  if (!val) {
    message.warning('请输入内容')
    return
  }
  if (drafts.value[cat.id].some((x) => x === val)) {
    message.warning('该条目已存在')
    return
  }
  drafts.value[cat.id].push(val)
  adding.value[cat.id] = ''
}

function removeRow(cat: ListCat, i: number): void {
  drafts.value[cat.id].splice(i, 1)
}

/** 保存某分类列表（网络白名单做 trim/去重/去空）。 */
async function saveCat(cat: ListCat): Promise<void> {
  try {
    const list = drafts.value[cat.id].map((x) => x.trim()).filter((x) => x.length > 0)
    const deduped = [...new Set(list)]
    if (cat.id === 'writable') await settings.saveSandboxWritableRoots(deduped)
    else if (cat.id === 'denyRead') await settings.saveSandboxDenyReadRoots(deduped)
    else await settings.saveSandboxNetworkAllowlist(deduped)
    message.success('已保存，下一条新启动的命令生效')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '保存失败')
  }
}

// ---- 平台支持状态 ----

const platform = ref<SandboxPlatformStatus | null>(null)
const installingWindows = ref(false)

async function loadPlatformStatus(): Promise<void> {
  try {
    platform.value = await mainClient.agent.getSandboxStatus()
  } catch {
    platform.value = null
  }
}
onMounted(loadPlatformStatus)

/** 当前平台后端的一句话描述。 */
function backendLabel(st: SandboxPlatformStatus): string {
  switch (st.platform) {
    case 'darwin':
      return 'macOS：系统 Seatbelt（sandbox-exec），开箱即用'
    case 'linux':
      return `Linux：bubblewrap${st.usable ? ' 已就绪' : '（未安装）'}`
    case 'win32':
      return `Windows：AppContainer 沙箱账户 + WFP${st.windows?.provisioned ? '（已安装）' : '（未安装）'}`
    default:
      return '当前平台不支持'
  }
}

/** Windows 供给（弹一次 UAC 创建账户 + 安装 WFP）。 */
async function installWindowsSandbox(): Promise<void> {
  if (installingWindows.value) return
  installingWindows.value = true
  try {
    const r = await mainClient.agent.provisionWindowsSandbox()
    if (r.ok) {
      message.success(r.message ? `沙箱组件安装成功：${r.message}` : '沙箱组件安装成功')
    } else {
      message.error(r.error ?? '安装失败，请重试或查看日志')
    }
    await loadPlatformStatus()
  } catch (err) {
    message.error(err instanceof Error ? err.message : '安装失败')
  } finally {
    installingWindows.value = false
  }
}
</script>

<template>
  <div>
    <NCard size="small" class="settings-card">
      <template #header>
        <span>平台支持状态</span>
      </template>
      <div v-if="!platform" class="list-empty">检测中…</div>
      <template v-else>
        <div class="status-row">
          <NTag size="small" :type="platform.usable ? 'success' : 'warning'">
            {{ backendLabel(platform) }}
          </NTag>
          <span class="status-note">{{
            platform.enabled ? '当前沙箱已开启' : '当前沙箱未开启'
          }}</span>
        </div>

        <!-- Linux：缺 bubblewrap 时的安装引导 -->
        <NAlert
          v-if="platform.platform === 'linux' && !platform.usable"
          type="warning"
          class="status-alert"
        >
          Linux 沙箱依赖 bubblewrap（bwrap），当前系统未检测到，安装后回到本页即可刷新：
          <ul class="status-cmds">
            <li>Debian / Ubuntu：<code>sudo apt-get install -y bubblewrap</code></li>
            <li>Fedora：<code>sudo dnf install -y bubblewrap</code></li>
            <li>Arch：<code>sudo pacman -S --noconfirm bubblewrap</code></li>
          </ul>
          未安装时开启沙箱会直接报错拒绝执行（不会降级直跑）。
        </NAlert>

        <!-- Windows：供给状态与安装入口 -->
        <template v-if="platform.platform === 'win32'">
          <NAlert v-if="platform.windows?.provisioned" type="success" class="status-alert">
            Windows 沙箱组件已安装（srt-sandbox 账户 + WFP 网络过滤），可直接开启沙箱。
          </NAlert>
          <NAlert v-else type="warning" class="status-alert">
            Windows 沙箱需要一次性安装：创建专用低权限账户（srt-sandbox）并安装网络过滤规则，
            将弹出一次管理员授权（UAC）。
            <template v-if="platform.windows?.error">
              最近一次检测异常：{{ platform.windows.error }}
            </template>
          </NAlert>
          <div v-if="!platform.windows?.provisioned" class="status-actions">
            <NButton type="primary" :loading="installingWindows" @click="installWindowsSandbox">
              安装沙箱组件
            </NButton>
          </div>
        </template>

        <NAlert v-if="platform.platform === 'other'" type="error" class="status-alert">
          当前平台不受沙箱后端支持，开启沙箱会直接报错拒绝执行。
        </NAlert>
      </template>
    </NCard>

    <NCard size="small" class="settings-card">
      <template #header>
        <span>沙箱总开关</span>
      </template>
      <p class="settings-card__desc">
        开启后，Agent 的 bash 命令（持久会话与后台命令）会整体运行在 OS 级沙箱中；文件类工具
        （write_file / edit_file / download 落盘 / read_file / grep）也受同一策略约束：
        只能写入工作区与「可写目录」，只能读取未被列入「禁止读取」的内容，外网访问仅放行
        「网络白名单」域名。默认关闭，维持现有直跑行为。
      </p>
      <div class="switch-row">
        <NSwitch :value="settings.sandboxEnabled" @update:value="toggleEnabled" />
        <span class="switch-row__label">{{ settings.sandboxEnabled ? '已开启' : '已关闭' }}</span>
      </div>
      <NAlert type="info" :show-icon="true" class="settings-card__alert">
        生效边界：沙箱在 shell 启动那一刻一次性施加，<b>已在运行的会话不受影响</b>（改动可写目录 /
        白名单后，重新发起命令并触发会话重建即可）；每台设备仅 macOS / Linux 支持，Windows
        需先完成沙箱安装（未安装时执行会直接报错拒绝，不会降级直跑）。
      </NAlert>
    </NCard>

    <NCard v-for="cat in cats" :key="cat.id" size="small" class="settings-card">
      <template #header>
        <span>{{ cat.label }}</span>
      </template>
      <p class="settings-card__desc">{{ cat.hint }}</p>

      <div v-if="drafts[cat.id].length === 0" class="list-empty">
        {{ cat.id === 'network' ? '暂无白名单（= 禁止全部外网）' : '暂未配置' }}
      </div>
      <div v-else class="path-list">
        <div v-for="(item, i) in drafts[cat.id]" :key="`${cat.id}-${i}`" class="path-row">
          <code class="path-row__value">{{ item }}</code>
          <NButton size="tiny" tertiary type="error" @click="removeRow(cat, i)">移除</NButton>
        </div>
      </div>

      <div class="list-add">
        <NInput
          v-model:value="adding[cat.id]"
          :placeholder="cat.placeholder"
          size="small"
          spellcheck="false"
          @keyup.enter="addRow(cat)"
        />
        <NButton size="small" tertiary @click="addRow(cat)">添加</NButton>
      </div>
      <div class="list-actions">
        <NButton size="small" type="primary" @click="saveCat(cat)">保存</NButton>
      </div>
    </NCard>
  </div>
</template>

<style scoped>
.settings-card {
  margin-bottom: 16px;
}
.settings-card__desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-3);
}
.settings-card__alert {
  margin-top: 12px;
}
.switch-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.switch-row__label {
  font-size: 13px;
  color: var(--text-1);
}
.list-empty {
  padding: 6px 0 10px;
  font-size: 13px;
  color: var(--text-3);
}
.path-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.path-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.path-row__value {
  font-size: 12px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.list-add {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.list-add .n-input {
  flex: 1;
}
.list-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}
.status-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.status-note {
  font-size: 12px;
  color: var(--text-3);
}
.status-alert {
  margin-top: 12px;
}
.status-cmds {
  margin: 8px 0 0;
  padding-left: 18px;
  line-height: 1.8;
}
.status-cmds code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  font-size: 12px;
}
.status-actions {
  margin-top: 12px;
}
</style>
