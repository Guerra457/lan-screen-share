const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  selectSource: (id, audio) => ipcRenderer.invoke('select-source', id, audio),
  startServer: (port, room) => ipcRenderer.invoke('start-server', port, room),
  stopServer: () => ipcRenderer.invoke('stop-server'),
});
