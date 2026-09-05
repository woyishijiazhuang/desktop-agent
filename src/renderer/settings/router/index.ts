import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import SettingsLayout from '../layouts/SettingsLayout.vue'

/**
 * 设置窗口内容路由：左侧栏（SettingsLayout）常驻，每个 tab 是 /settings 的一条
 * **懒加载**子路由——打开设置窗口只加载布局壳 + 当前 tab 的视图 chunk，其余 tab
 * 进入时才按需拉取。
 *
 * 主进程经 loadAppViews 以 hash 进入（settings/index.html#/settings/<tab>，见 window-manager）。
 */
export const SETTINGS_ROUTE_BASE = '/settings'

const routes: RouteRecordRaw[] = [
  {
    path: SETTINGS_ROUTE_BASE,
    component: SettingsLayout,
    children: [
      { path: '', redirect: `${SETTINGS_ROUTE_BASE}/general` },
      {
        path: 'general',
        name: 'settings-general',
        component: () => import('../views/GeneralView.vue')
      },
      {
        path: 'workspace',
        name: 'settings-workspace',
        component: () => import('../views/WorkspaceView.vue')
      },
      {
        path: 'models',
        name: 'settings-models',
        component: () => import('../views/ModelsView.vue')
      },
      {
        path: 'usage',
        name: 'settings-usage',
        component: () => import('../views/UsageView.vue')
      },
      {
        path: 'tools',
        name: 'settings-tools',
        component: () => import('../views/ToolsView.vue')
      },
      {
        path: 'skills',
        name: 'settings-skills',
        component: () => import('../views/SkillsView.vue')
      },
      {
        path: 'memory',
        name: 'settings-memory',
        component: () => import('../views/MemoryView.vue')
      },
      {
        path: 'knowledge',
        name: 'settings-knowledge',
        component: () => import('../views/KnowledgeView.vue')
      },
      {
        path: 'mcp',
        name: 'settings-mcp',
        component: () => import('../views/McpView.vue')
      },
      {
        path: 'voice',
        name: 'settings-voice',
        component: () => import('../views/VoiceView.vue')
      },
      {
        path: 'data',
        name: 'settings-data',
        component: () => import('../views/DataView.vue')
      },
      {
        path: 'about',
        name: 'settings-about',
        component: () => import('../views/AboutView.vue')
      }
    ]
  },
  // 未知路径（含无 hash 的初始加载）一律落到默认分类
  { path: '/:pathMatch(.*)*', redirect: `${SETTINGS_ROUTE_BASE}/general` }
]

export default createRouter({
  history: createWebHashHistory(),
  routes
})
