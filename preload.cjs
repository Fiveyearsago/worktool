'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const methods = Object.fromEntries(['bastionAccessibility','bastionConnect','bastionAuthStatus','bastionAuthSave','bastionAuthRemove','bastionAuthRefresh','pickAppIcon','discardAppIcon','documentOpenLink','bastionStatus','bastionStart','bastionOpen','knowledgeConnect','knowledgeSync','knowledgeStatus','knowledgeOpen','aiStatus','aiSave','aiTest','importCancel','importUpdateText','importClipboard','importChoose','importText','importReparse','importDiscard','importCommit','load','save','pickFile','openFile','openUrl','gitStatus','gitSync','chooseWorkspace'].map(k => [k, (...args) => ipcRenderer.invoke('hub:' + k, ...args)]));
methods.importDrop = (file, options) => {
  const filePath = webUtils.getPathForFile(file);
  if (!filePath) throw Error('无法读取拖入文件，请从 Finder / 文件管理器拖入，或点击选择文件。');
  return ipcRenderer.invoke('hub:importPath', filePath, options);
};
contextBridge.exposeInMainWorld('hub', methods);
