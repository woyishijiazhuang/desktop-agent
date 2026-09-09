import './assets/main.css'
import 'markstream-vue/index.css'

import { createApp, defineAsyncComponent } from 'vue'
import App from './App.vue'
import { createPinia } from 'pinia'
import router from './router'
import './service'
import { useThemeStore } from './store/useThemeStore'
// markstream 语言级覆盖：```echarts 围栏 → ECharts 图表。
// 须在 MarkdownRender（custom-id="chat"）首次挂载前完成注册。
// EChartsBlock 经 defineAsyncComponent 注册：入口仅持有占位，真正渲染 ```echarts
// 代码块时才动态加载组件及其 echarts 依赖（把 ~1.9MB echarts 移出入口启动图）。
import { setCustomComponents } from 'markstream-vue'

setCustomComponents('chat', {
  echarts: defineAsyncComponent(() => import('./components/chat/EChartsBlock.vue'))
})

const pinia = createPinia()
// 首屏挂载前同步应用主题（在 <html> 上落 .dark），避免深色模式 FOUC
useThemeStore(pinia)
createApp(App).use(pinia).use(router).mount('#app')
