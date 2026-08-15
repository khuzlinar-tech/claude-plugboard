'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('app:state'),
  getInfo: () => ipcRenderer.invoke('app:info'),
  planUsage: () => ipcRenderer.invoke('usage:plan'),
  apiUsage: (force) => ipcRenderer.invoke('usage:api', { force }),
  cliUsage: () => ipcRenderer.invoke('usage:cli'),

  openMain: (tab) => ipcRenderer.invoke('app:showMain', tab),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  popupData: () => ipcRenderer.invoke('popup:data'),
  popupSwitch: (slot) => ipcRenderer.invoke('popup:switch', slot),
  popupHide: () => ipcRenderer.send('popup:hide'),
  openClaudeTerminal: () => ipcRenderer.invoke('claude:openTerminal'),

  statusline: {
    status: () => ipcRenderer.invoke('statusline:status'),
    preview: () => ipcRenderer.invoke('statusline:preview'),
    reinstall: () => ipcRenderer.invoke('statusline:reinstall'),
  },

  apiTokenState: (slot) => ipcRenderer.invoke('api:tokenState', slot),
  setApiToken: (slot, token) => ipcRenderer.invoke('api:setToken', { slot, token }),
  calibrateWeekly: (orgUuid, epochMs) => ipcRenderer.invoke('api:calibrate', { orgUuid, epochMs }),

  dict: () => ipcRenderer.invoke('i18n:dict'),
  languages: () => ipcRenderer.invoke('i18n:list'),
  theme: () => ipcRenderer.invoke('theme:get'),

  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
    reset: () => ipcRenderer.invoke('config:reset'),
  },

  consent: {
    accept: () => ipcRenderer.invoke('consent:accept'),
    decline: () => ipcRenderer.invoke('consent:decline'),
    show: () => ipcRenderer.invoke('consent:show'),
    mode: () => ipcRenderer.invoke('consent:mode'),
  },

  switchProfile: (slot, autoClose) => ipcRenderer.invoke('profile:switch', { slot, autoClose }),
  addProfile: (name) => ipcRenderer.invoke('profile:add', name),
  adoptProfile: (name) => ipcRenderer.invoke('profile:adopt', name),
  deleteProfile: (slot) => ipcRenderer.invoke('profile:delete', slot),
  setProfileMeta: (slot, patch) => ipcRenderer.invoke('profile:meta', { slot, patch }),

  launchClaude: () => ipcRenderer.invoke('claude:launch'),
  closeClaude: () => ipcRenderer.invoke('claude:close'),
  claudeState: () => ipcRenderer.invoke('claude:state'),
  detectClaude: () => ipcRenderer.invoke('claude:detect'),
  chooseClaudeExe: () => ipcRenderer.invoke('claude:chooseExe'),

  openPath: (target) => ipcRenderer.invoke('shell:open', target),
  openExternal: (url) => ipcRenderer.invoke('shell:external', url),
  openSettings: () => ipcRenderer.invoke('settings:open'),

  onClaudeState: (cb) => ipcRenderer.on('claude:state', (_e, data) => cb(data)),
  onUsageChanged: (cb) => ipcRenderer.on('usage:changed', () => cb()),
  onProfilesChanged: (cb) => ipcRenderer.on('profiles:changed', () => cb()),
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_e, data) => cb(data)),
  onLanguageChanged: (cb) => ipcRenderer.on('i18n:changed', (_e, data) => cb(data)),
  onThemeChanged: (cb) => ipcRenderer.on('theme:changed', (_e, data) => cb(data)),
  onNavigate: (cb) => ipcRenderer.on('nav:tab', (_e, tab) => cb(tab)),
  onSwitchRequest: (cb) => ipcRenderer.on('ui:switchRequest', (_e, slot) => cb(slot)),
  onApiPrompt: (cb) => ipcRenderer.on('ui:apiPrompt', () => cb()),
  onStatuslineChanged: (cb) => ipcRenderer.on('statusline:changed', (_e, data) => cb(data)),
  onPopupRefresh: (cb) => ipcRenderer.on('popup:refresh', () => cb()),
  onCliProgress: (cb) => ipcRenderer.on('usage:cliProgress', (_e, data) => cb(data)),

  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
  },
});
