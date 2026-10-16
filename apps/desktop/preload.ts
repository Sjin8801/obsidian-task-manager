import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from './shared.ts';
const bridge: DesktopBridge = {
  setAutoStart: value => ipcRenderer.invoke('task:setAutoStart', value),
  setHeadlessSync: value => ipcRenderer.invoke('task:setHeadlessSync', value),
  retryHeadlessSync: () => ipcRenderer.invoke('task:retryHeadlessSync'),
  onSyncStatus: callback => {
    const listener = (_event: unknown, value: Parameters<typeof callback>[0]) => callback(value); ipcRenderer.on('task:syncStatus', listener);
    return () => { ipcRenderer.removeListener('task:syncStatus', listener); };
  },
  setShortcut: value => ipcRenderer.invoke('task:setShortcut', value),
  setShortcutCapture: value => ipcRenderer.invoke('task:setShortcutCapture', value),
  addCategory: name => ipcRenderer.invoke('task:addCategory', name),
  saveTask: input => ipcRenderer.invoke('task:saveTask', input),
  setLanguage: value => ipcRenderer.invoke('task:setLanguage', value),
  status: () => ipcRenderer.invoke('task:status'),
  selectVault: () => ipcRenderer.invoke('task:selectVault'),
  selectTaskFolder: () => ipcRenderer.invoke('task:selectTaskFolder'),
  agenda: scope => ipcRenderer.invoke('task:agenda', scope),
  search: input => ipcRenderer.invoke('task:search', input),
  editRelation: input => ipcRenderer.invoke('task:editRelation', input),
  findRelated: input => ipcRenderer.invoke('task:findRelated', input),
  forgetVault: () => ipcRenderer.invoke('task:forgetVault'),
  showPet: () => ipcRenderer.invoke('task:showPet'),
  onOpenTask: callback => {
    const listener = (_event: unknown, value: Parameters<typeof callback>[0]) => callback(value); ipcRenderer.on('task:openTask', listener);
    return () => { ipcRenderer.removeListener('task:openTask', listener); };
  },
  hide: () => ipcRenderer.invoke('task:hide'),
  getTask: path => ipcRenderer.invoke('task:getTask', path),
  onChanged: callback => {
    const listener = () => callback(); ipcRenderer.on('task:changed', listener);
    return () => { ipcRenderer.removeListener('task:changed', listener); };
  },
  onBack: callback => {
    const listener = () => callback(); ipcRenderer.on('task:back', listener);
    return () => { ipcRenderer.removeListener('task:back', listener); };
  },
  onShow: callback => {
    const listener = () => callback(); ipcRenderer.on('task:show', listener);
    return () => { ipcRenderer.removeListener('task:show', listener); };
  },
};
contextBridge.exposeInMainWorld('taskManager', bridge);
