import log from 'electron-log/main'

/** electron-log scope 返回的日志函数集合类型。 */
type LogFunctions = ReturnType<typeof log.scope>

/**
 * 主进程日志（electron-log）：
 * - 初始化后自动捕获主进程 console 输出写入文件
 * - 捕获渲染进程（含 preload）的 console 输出，便于一并排查前端问题
 * - 捕获未捕获异常 / 未处理的 Promise 拒绝，落盘为 error 级别
 * - 日志目录随平台：macOS 为 ~/Library/Logs/{appName}/，Linux/Windows 为 userData/logs/
 * - 默认按大小轮转（maxSize 5MB）：超限后当前文件归档为 main.old.log，重新写入 main.log
 */
log.initialize({ spyRendererConsole: true })
log.errorHandler.startCatching({ showDialog: false })

/** 文件保留全部级别（debug/info 供日常排查，error 供故障定位）。 */
log.transports.file.level = 'silly'
/** 单文件上限 5MB，超限轮转为 main.old.log。 */
log.transports.file.maxSize = 5 * 1024 * 1024
/** 统一格式：时间 / 级别 / 作用域 / 内容。 */
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] [{scope}] {text}'

/** 实际日志文件路径（运行时解析，供设置页展示目录与清空日志）。 */
export function getLogFilePath(): string {
  return log.transports.file.getFile().path
}

/** 清空日志文件内容（保留文件，electron-log 继续写入）。 */
export function clearLogFile(): boolean {
  return log.transports.file.getFile().clear()
}

/**
 * 创建带作用域标签的 logger：日志行会携带模块名（如 [agent]），
 * 便于在多进程/多模块日志中快速过滤定位。
 */
export function createLogger(scope: string): LogFunctions {
  return log.scope(scope)
}

export default log
