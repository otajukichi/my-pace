import test from 'node:test';import assert from 'node:assert/strict';import {exportRecoveryAppJSON} from '../../gas/backup-export.mjs';import {parseBackup} from '../../src/lib/domain.js';
test('owner recovery export is accepted by unchanged app importer',()=>{const text=exportRecoveryAppJSON({'diary:2026-10-08':{text:'大切な日記',mood:null},'wake:2026-10-08':'07:00'});const state=parseBackup(text);assert.equal(state.diary['2026-10-08'].text,'大切な日記');assert.equal(state.wake['2026-10-08'],'07:00');});
test('invalid app records never become claimed compatible export',()=>{assert.throws(()=>exportRecoveryAppJSON({'diary:bad':{text:'x'}}));});

test('orphan habit logs cannot silently disappear from an exported snapshot',()=>{assert.throws(()=>exportRecoveryAppJSON({'habitLog:missing:2026-10-08':true}),/BACKUP_EXPORT_RECORD_MISMATCH/);});
