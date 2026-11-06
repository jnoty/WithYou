'use strict';
const fs = require('fs');
async function locateResource(target, shell, stat = fs.statSync) {
  const entry = stat(target);
  if (entry.isDirectory()) {
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  } else {
    shell.showItemInFolder(target);
  }
}
module.exports = { locateResource };
