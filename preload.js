'use strict';

/**
 * 预加载脚本：向渲染进程暴露最小安全 API（contextBridge）。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('withyou', {
  ai: Object.fromEntries(['test-connection', 'drafts', 'edit-draft', 'preview', 'take-preview', 'config', 'set-default', 'delete-provider', 'list-models', 'save-config', 'analyze', 'cancel', 'commit', 'undo', 'sources', 'source'].map(name => [name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), input => ipcRenderer.invoke('ai:' + name, input)])),
  tasks: {
    updateSeries: input => ipcRenderer.invoke('tasks:update-series', input),
    list: () => ipcRenderer.invoke('tasks:list'),
    create: (input) => ipcRenderer.invoke('tasks:create', input),
    update: (id, patch) => ipcRenderer.invoke('tasks:update', id, patch),
    delete: (id) => ipcRenderer.invoke('tasks:delete', id),
    restore: (task, index) => ipcRenderer.invoke('tasks:restore', task, index),
    reorder: (status, orderedIds) => ipcRenderer.invoke('tasks:reorder', status, orderedIds),
    planRecurring: (input) => ipcRenderer.invoke('tasks:plan-recurring', input),
    createRecurring: (input) => ipcRenderer.invoke('tasks:create-recurring', input),
    export: input => ipcRenderer.invoke('tasks:export', input),
    import: () => ipcRenderer.invoke('tasks:import'),
    onChanged: (handler) => {
      const listener = (_e, tasks) => handler(tasks);
      ipcRenderer.on('tasks:changed', listener);
      return () => ipcRenderer.removeListener('tasks:changed', listener);
    },
  },
  projectResources: {
    list: () => ipcRenderer.invoke('project-resources:list'),
    check: () => ipcRenderer.invoke('project-resources:check'),
    save: (item) => ipcRenderer.invoke('project-resources:save', item),
    delete: (id) => ipcRenderer.invoke('project-resources:delete', id),
    open: (location) => ipcRenderer.invoke('project-resources:open', location),
    reveal: (location) => ipcRenderer.invoke('project-resources:reveal', location),
    choosePath: (current) => ipcRenderer.invoke('project-resources:choose-path', current),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  app: {
    onAIPreview: handler => {
      const listener = () => handler();
      ipcRenderer.on('ai:preview-ready', listener);
      return () => ipcRenderer.removeListener('ai:preview-ready', listener);
    },
    onLanguageChanged: (handler) => {
      const listener = (_e, language) => handler(language);
      ipcRenderer.on('app:language-changed', listener);
      return () => ipcRenderer.removeListener('app:language-changed', listener);
    },
    onSettingsChanged: (handler) => {
      const listener = (_e, settings) => handler(settings);
      ipcRenderer.on('app:settings-changed', listener);
      return () => ipcRenderer.removeListener('app:settings-changed', listener);
    },
    quickCapture: () => ipcRenderer.invoke('app:quick-capture'),
    hideQuick: () => ipcRenderer.invoke('app:hide-quick'),
    onQuickFocus: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('quick:focus', listener);
      return () => ipcRenderer.removeListener('quick:focus', listener);
    },
    onOpenSettings: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('app:open-settings', listener);
      return () => ipcRenderer.removeListener('app:open-settings', listener);
    },
  },
  pet: {
    onDock: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('pet:dock', listener);
      return () => ipcRenderer.removeListener('pet:dock', listener);
    },
    setInteractive: (value) => ipcRenderer.send('pet:hit-test', Boolean(value)),
    previewClips: () => ipcRenderer.invoke('pet:preview-clips'),
    previewReminder: () => ipcRenderer.invoke('pet:preview-reminder'),
    onMotion: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('pet:motion', listener);
      return () => ipcRenderer.removeListener('pet:motion', listener);
    },
    load: () => ipcRenderer.invoke('pet:load'),
    interact: (action) => ipcRenderer.invoke('pet:interact', action),
    message: (event) => ipcRenderer.invoke('pet:message', event),
    dragStart: () => ipcRenderer.send('pet:drag-start'),
    dragEnd: () => ipcRenderer.send('pet:drag-end'),
    contextMenu: () => ipcRenderer.send('pet:context-menu'),
    onEvent: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('pet:event', listener);
      return () => ipcRenderer.removeListener('pet:event', listener);
    },
    onStats: (handler) => {
      const listener = (_e, payload) => handler(payload);
      ipcRenderer.on('pet:stats', listener);
      return () => ipcRenderer.removeListener('pet:stats', listener);
    },
    onCommand: (handler) => {
      const listener = (_e, cmd) => handler(cmd);
      ipcRenderer.on('pet:command', listener);
      return () => ipcRenderer.removeListener('pet:command', listener);
    },
  },
});
