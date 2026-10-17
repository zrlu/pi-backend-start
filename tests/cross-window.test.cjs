const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let lane = 60000 + Math.floor(Math.random() * 10000);
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-backend-test-'));
  const config = path.join(root, 'backends.json');
  const sharedLane = lane++;
  fs.writeFileSync(config, JSON.stringify(['a', 'b'].map((name, i) => ({ key: `local-xpu-${name}/${name}`, alias: name, port: sharedLane + i, lane: sharedLane, served: name, cwd: '.', script: 'unused', start: [], stop: [], readySec: 5, manual: false }))));
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ active: null, ready: false }));
  return { root, config, events: () => fs.existsSync(path.join(root, 'events.jsonl')) ? fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}
function worker(f, target, action) {
  const child = spawn(process.execPath, [path.join(__dirname, 'worker.cjs'), f.root, f.config, target, action], { windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(output || `worker exit ${code}`)));
  });
  return { child, done };
}
async function launched(f) {
  const until = Date.now() + 5000;
  while (!f.events().some(e => e.type === 'launch')) {
    if (Date.now() > until) throw Error('first worker did not launch');
    await sleep(15);
  }
}
test('two cold windows launch the same backend only once, including Docker visibility gap', async () => {
  const f = fixture();
  const first = worker(f, 'a', 'auto');
  await launched(f);
  const second = worker(f, 'a', 'auto');
  await Promise.all([first.done, second.done]);
  const events = f.events();
  assert.equal(events.filter(e => e.type === 'launch').length, 1);
  assert(!events.some(e => e.type === 'stop'));
  assert(events.find(e => e.pid === second.child.pid && e.type === 'complete').at >= events.find(e => e.type === 'launcherDone').at);
});
test('a different automatic profile cannot replace a warming backend on another port of the same GPU', async () => {
  const f = fixture(), first = worker(f, 'a', 'auto');
  await launched(f);
  const second = worker(f, 'b', 'auto');
  await Promise.all([first.done, second.done]);
  assert.deepEqual(f.events().filter(e => ['launch', 'stop'].includes(e.type)).map(e => [e.type, e.alias]), [['launch', 'a']]);
  assert(f.events().some(e => e.type === 'notice' && e.text.includes('automatic startup of b was skipped')));
});
test('explicit stop waits for the other window launcher to exit even after HTTP readiness', async () => {
  const f = fixture(), first = worker(f, 'a', 'auto');
  await launched(f);
  const second = worker(f, 'a', 'stop');
  await Promise.all([first.done, second.done]);
  const events = f.events();
  assert(events.findIndex(e => e.type === 'stop') > events.findIndex(e => e.type === 'launcherDone'));
});
test('restart keeps stop and subsequent launch in one shared transaction', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, 'state.json'), JSON.stringify({ active: 'a', ready: true }));
  const first = worker(f, 'a', 'restart');
  await launched(f);
  const second = worker(f, 'a', 'auto');
  await Promise.all([first.done, second.done]);
  assert.deepEqual(f.events().filter(e => ['stop', 'launch'].includes(e.type)).map(e => e.type), ['stop', 'launch']);
});
test('an exited window cannot leave a stale lock blocking the next window', async () => {
  const sharedLane = lane++;
  function lockWorker(mode) {
    const child = spawn(process.execPath, [path.join(__dirname, 'lock-worker.cjs'), String(sharedLane), mode], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const acquired = new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('close', code => { if (code !== 0) reject(new Error(`lock worker exited ${code}`)); });
    });
    return { child, acquired };
  }
  const first = lockWorker('hold');
  await first.acquired;
  const closed = new Promise(resolve => first.child.once('close', resolve));
  first.child.kill();
  await closed;
  const second = lockWorker('release');
  const timeout = setTimeout(() => second.child.kill(), 5000);
  try { await second.acquired; } finally { clearTimeout(timeout); }
});
