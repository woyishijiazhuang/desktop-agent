import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import DefaultLayout from '@renderer/layouts/DefaultLayout.vue'
import { useWindowStore } from '@renderer/store/useWindowStore'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: DefaultLayout,
    children: [
      {
        path: '',
        redirect: '/chat'
      },
      {
        path: 'chat',
        name: 'chat',
        component: () => import('@renderer/views/ChatView.vue'),
        meta: { title: '对话' }
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@renderer/views/SettingsView.vue'),
        meta: { title: '设置' }
      }
    ]
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

// 设置页只在独立设置窗口中展示：工作区窗口若被导航到 /settings（如手动改 hash），
// 一律重定向回对话页。设置窗口自身的初始加载（initWindow 未完成时 initialized=false）
// 与确认后的「settings」窗口类型均不受影响；UI 入口（侧栏/引导/托盘）已统一改为
// mainClient.window.openSettingsWindow() 打开独立设置窗口，此处仅兜底拦截。
router.beforeEach((to) => {
  if (to.path !== '/settings') return true
  const windowStore = useWindowStore()
  if (windowStore.initialized && windowStore.state.windowType === 'workspace') {
    return { path: '/chat' }
  }
  return true
})

router.afterEach((to) => {
  const title = to.meta.title as string | undefined
  document.title = title ? `${title} - 桌面助手` : '桌面助手'
})

export default router
