// electron-log 桩：主进程外运行工具测试用（验证后删除）
const noop = () => {}
export default {
  initialize: noop,
  errorHandler: { startCatching: noop },
  transports: { file: { level: '', maxSize: 0, format: '' } },
  scope: () => ({ info: noop, warn: noop, error: noop, debug: noop })
}
