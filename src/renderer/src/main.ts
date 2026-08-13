import './assets/main.css'
import 'markstream-vue/index.css'

import { createApp } from 'vue'
import App from './App.vue'
import { createPinia } from 'pinia'
import router from './router'
import './service'
import { useThemeStore } from './store/useThemeStore'
// markstream 语言级覆盖：```echarts 围栏 → ECharts 图表。
// 须在 MarkdownRender（custom-id="chat"）首次挂载前完成注册。
import { setCustomComponents } from 'markstream-vue'
import EChartsBlock from './components/chat/EChartsBlock.vue'

setCustomComponents('chat', { echarts: EChartsBlock })

const pinia = createPinia()
// 首屏挂载前同步应用主题（在 <html> 上落 .dark），避免深色模式 FOUC
useThemeStore(pinia)
createApp(App).use(pinia).use(router).mount('#app')
