import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
test('generated GAS bundle loads without Node codecs and prepares linked immutable payloads',()=>{
 execFileSync(process.execPath,['build-gas.mjs'],{cwd:new URL('.',import.meta.url)});
 const context={};vm.createContext(context);vm.runInContext(fs.readFileSync(new URL('gas/FolderImport.gs',import.meta.url),'utf8'),context);
 assert.equal(context.Buffer,undefined);assert.equal(context.TextDecoder,undefined);assert.equal(context.TextEncoder,undefined);
 const api=context.MyPaceFolderImport;assert.equal(typeof api.ImportCheckpointCoordinator,'function');assert.equal(typeof api.createDriveSourceTransport,'function');
 const bytes=api.encodeUtf8('# sensor:multi_record\ntime,latitude,longitude\n2026-01-01T00:00:00.123456Z,1,2\n');
 const cp=api.initialCheckpoint({id:'source',version:'1',md5Checksum:createHash('md5').update(bytes).digest('hex'),size:String(bytes.length)});
 const prepared=api.prepareRange(cp,bytes);const staged=api.buildStagedPayloads(prepared,{outputIds:['output1'],manifestId:'manifest1',checkpointId:'checkpoint1'});
 assert.equal(staged.checkpoint.complete,true);assert.equal(staged.checkpoint.points,1);assert.equal(staged.assets.length,3);assert.equal(staged.checkpoint.previousManifest.fileId,'manifest1');
 const manifest=JSON.parse(api.decodeUtf8(staged.assets[1].bytes));assert.equal(manifest.previous,null);assert.equal(manifest.outputs[0].fileId,'output1');
 for(const a of staged.assets)assert.equal(a.sha256,createHash('sha256').update(a.bytes).digest('hex'));
});
