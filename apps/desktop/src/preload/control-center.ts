import { contextBridge, ipcRenderer } from 'electron';
import { createControlCenterBridge } from './bridge.js';

contextBridge.exposeInMainWorld('petDesktop', createControlCenterBridge(ipcRenderer));
