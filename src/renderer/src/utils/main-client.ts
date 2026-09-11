import { createIpcRendererClient } from 'electron-ipc-service/renderer'
import type { IpcMainServices } from '../../../main/services'

export const mainClient = createIpcRendererClient<IpcMainServices>()
