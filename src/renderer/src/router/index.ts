import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import DefaultLayout from '@renderer/layouts/DefaultLayout.vue'

// 设置页已迁移到独立窗口入口（src/renderer/settings），不再属于工作区 SPA 的路由：
// 工作区窗口的「打开设置」入口统一走 mainClient.window.openSettingsWindow()，
// 这里只保留对话页单路由（/settings 相关的守卫与懒加载路由一并移除）。
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
      }
    ]
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

router.afterEach((to) => {
  const title = to.meta.title as string | undefined
  document.title = title ? `${title} - 桌面助手` : '桌面助手'
})

export default router
