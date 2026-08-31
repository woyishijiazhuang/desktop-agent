<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NCard, NTag } from 'naive-ui'
import { mainClient } from '@renderer/utils/main-client'

/** 应用版本。 */
const appVersion = ref('')

onMounted(async () => {
  appVersion.value = await mainClient.app.getAppVersion()
})
</script>

<template>
  <div>
    <NCard size="small" class="settings-card">
      <template #header>
        <span>关于</span>
      </template>
      <div class="about">
        <div class="about__head">
          <div class="about__icon">AI</div>
          <div>
            <h2 class="about__title">桌面助手</h2>
            <p class="about__subtitle">
              本地优先的 AI 对话助手
              <span v-if="appVersion" class="about__version">v{{ appVersion }}</span>
            </p>
          </div>
        </div>

        <section class="about__section">
          <h3 class="about__heading">简介</h3>
          <p class="about__text">
            基于 <code>Electron</code> + <code>Vue 3</code> +
            <code>TypeScript</code> 构建的桌面端 AI 对话助手。支持多家模型服务商与自定义
            OpenAI/Anthropic 兼容端点，API Key 经系统安全存储加密，不会离开你的设备。
          </p>
          <p class="about__text">
            内置文件读写、命令执行、网页搜索、技能市场、MCP
            扩展等工具能力，并支持会话压缩、长期记忆与用量统计。
          </p>
        </section>

        <section class="about__section">
          <h3 class="about__heading">技术栈</h3>
          <ul class="about__list">
            <li><code>Electron</code> + <code>electron-vite</code> 跨平台桌面壳</li>
            <li><code>Vue 3</code> + <code>Pinia</code> + <code>Vue Router</code> 前端框架</li>
            <li><code>Naive UI</code> 组件库，深浅双主题</li>
            <li>
              <code>@earendil-works/pi-ai</code> + <code>pi-agent-core</code> 模型与 Agent 能力
            </li>
            <li><code>node:sqlite</code> 本地数据库 + MCP 协议支持</li>
          </ul>
        </section>

        <section class="about__section">
          <h3 class="about__heading">关键能力</h3>
          <div class="about__tags">
            <NTag size="small" :bordered="false">多模型管理</NTag>
            <NTag size="small" :bordered="false">流式渲染</NTag>
            <NTag size="small" :bordered="false">工具调用</NTag>
            <NTag size="small" :bordered="false">MCP 扩展</NTag>
            <NTag size="small" :bordered="false">技能市场</NTag>
            <NTag size="small" :bordered="false">长期记忆</NTag>
            <NTag size="small" :bordered="false">会话压缩</NTag>
            <NTag size="small" :bordered="false">用量统计</NTag>
          </div>
        </section>
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

/* 关于 */
.about {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.about__head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.about__icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--primary);
  color: #fff;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}
.about__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--text-1);
}
.about__subtitle {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-3);
}
.about__version {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-mute);
  font-size: 11px;
  color: var(--text-2);
}
.about__section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.about__heading {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.about__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-2);
}
.about__list {
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.about__list li {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-2);
}
.about__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.about code {
  background: var(--bg-mute);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-1);
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
}
</style>
