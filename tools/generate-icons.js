'use strict';
// Generate faithful Windows icon sizes from the approved PNG master.
// Run: node tools/generate-icons.js (Windows, built-in System.Drawing).
const path = require('node:path');
const { execFileSync } = require('node:child_process');
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'generate-icons.ps1'), '-ProjectRoot', path.resolve(__dirname, '..')], { stdio: 'inherit', windowsHide: true });
