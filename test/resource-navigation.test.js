'use strict';
const assert = require('node:assert/strict');
const {locateResource} = require('../src/resource-navigation');
(async () => {
  const calls = [];
  const shell = {openPath: async target => {calls.push(['open',target]);return '';}, showItemInFolder: target => calls.push(['reveal',target])};
  await locateResource('C:/project/docs',shell,() => ({isDirectory:() => true}));
  await locateResource('C:/project/report.docx',shell,() => ({isDirectory:() => false}));
  assert.deepEqual(calls,[['open','C:/project/docs'],['reveal','C:/project/report.docx']]);
  await assert.rejects(locateResource('missing',shell,() => {throw new Error('ENOENT');}), /ENOENT/);
  await assert.rejects(locateResource('denied',{openPath:async()=> 'Access denied'},()=>({isDirectory:()=>true})), /Access denied/);
  assert.equal(calls.length,2);
  console.log('Resource navigation: folders open, files reveal, missing and denied paths report errors.');
})().catch(e => {console.error(e);process.exitCode=1;});
