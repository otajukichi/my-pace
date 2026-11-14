import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceOverride, runningSource, readAccount, loginErrorMessage } from '../lib/account.js';
const pending = { phase:'checking',configured:null,authenticated:null,error:'' };

test('normal URL selects the signed-in account; old data requires an explicit diagnostic URL', () => {
  assert.equal(sourceOverride(''),null);assert.equal(sourceOverride('?source=unexpected'),null);
  assert.equal(runningSource(null,pending),'checking');
  assert.equal(runningSource(null,{phase:'ready',authenticated:true}),'drive');
  assert.equal(runningSource(null,{phase:'ready',authenticated:false}),'guest');
  assert.equal(runningSource(sourceOverride('?source=local'),pending),'local');
  assert.equal(runningSource(sourceOverride('?source=drive'),{phase:'ready',authenticated:false}),'guest');
});
test('a failed session check is not a logout and does not fall back to another dataset', async () => {
  const unavailable = async () => { throw Error('internal provider details'); };
  const first = await readAccount(pending,unavailable);
  assert.equal(runningSource(null,first),'unavailable');assert(!first.error.includes('provider'));
  const connected = await readAccount(pending,async()=>({configured:true,authenticated:true}));
  const offline = await readAccount(connected,unavailable);
  assert.equal(offline.phase,'error');assert.equal(runningSource(null,offline),'drive');
  const signedOut = await readAccount(offline,async()=>({configured:true,authenticated:false}));
  assert.equal(runningSource(null,signedOut),'guest');
});
test('missing setup, invalid status and OAuth errors have distinct recoverable outcomes', async () => {
  const unconfigured = await readAccount(pending,async()=>{throw Object.assign(Error('secret detail'),{code:'NOT_CONFIGURED'});});
  assert.equal(unconfigured.configured,false);assert.equal(runningSource(null,unconfigured),'guest');
  assert.equal((await readAccount(pending,async()=>({authenticated:'yes'}))).phase,'error');
  assert.match(loginErrorMessage('OWNER_ONLY'),/所有者/);
  assert.match(loginErrorMessage('SIGN_IN_CANCELLED'),/完了していません/);
  assert(!loginErrorMessage('<private provider error>').includes('private'));
});
