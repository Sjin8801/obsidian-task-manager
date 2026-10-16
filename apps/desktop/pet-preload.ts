import { contextBridge, ipcRenderer } from 'electron';
import type { PetBridge, PetView } from './pet-model.ts';
const bridge: PetBridge = {
  state: () => ipcRenderer.invoke('pet:state'), expand: value => ipcRenderer.invoke('pet:expand', value),
  fit: peekHeight => ipcRenderer.invoke('pet:fit', peekHeight), passThrough: value => ipcRenderer.invoke('pet:passThrough', value),
  open: task => ipcRenderer.invoke('pet:open', task), menu: () => ipcRenderer.invoke('pet:menu'),
  taskMenu: task => ipcRenderer.invoke('pet:taskMenu', task), theme: value => ipcRenderer.invoke('pet:theme', value), undo: () => ipcRenderer.invoke('pet:undo'),
  drag: value => ipcRenderer.invoke('pet:drag', value),
  onState: callback => { const listener = (_event: unknown, state: PetView) => callback(state); ipcRenderer.on('pet:state', listener); return () => { ipcRenderer.removeListener('pet:state', listener); }; },
  onPointerLeft: callback => { const listener = () => callback(); ipcRenderer.on('pet:pointerLeft', listener); return () => { ipcRenderer.removeListener('pet:pointerLeft', listener); }; },
};
contextBridge.exposeInMainWorld('taskPet', bridge);
