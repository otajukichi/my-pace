import test from 'node:test';import assert from 'node:assert/strict';
import {measureUnchangedFolderDay} from './scheduled-idle-scaling.mjs';
for(const evictEveryTick of [false,true])test(`24h unchanged 145-source scaling with cache eviction=${evictEveryTick}`,()=>{const result=measureUnchangedFolderDay({evictEveryTick});assert(result.completedDiscoverySweeps>0);assert(result.partialDiscoveryTicks>0);assert.equal(result.newFiles,1);assert.equal(result.rollingWorkLedgerDoesNotIncludeIdle,true);console.log(JSON.stringify(result));});
