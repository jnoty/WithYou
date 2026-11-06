'use strict';
function canAccessAI(event, name, mainWindow, quickWindow) {
  const matches = win => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  return Boolean(matches(mainWindow) || (matches(quickWindow) && ['config', 'analyze', 'preview', 'cancel'].includes(name)));
}
module.exports = { canAccessAI };
