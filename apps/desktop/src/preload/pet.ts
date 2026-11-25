import { contextBridge, ipcRenderer } from 'electron';
import { createPetBridge } from './bridge.js';

contextBridge.exposeInMainWorld('petDesktop', createPetBridge(ipcRenderer));
