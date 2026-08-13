import { createIpcRendererClient } from 'electron-ipc-service/renderer'
import type { IpcMainServices } from '../../../main/service'

export const mainClient = createIpcRendererClient<IpcMainServices>()
