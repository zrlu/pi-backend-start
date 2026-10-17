const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const [root, config, target, action = 'auto'] = process.argv.slice(2);
process.env.PI_BACKEND_CONFIG = config;
const install = path.join(os.homedir(), '.pi/agent/install');
const version = fs.readFileSync(path.join(install, 'current-version'), 'utf8').trim();
const { createJiti } = require(path.join(install, 'releases', version, 'node_modules/jiti/lib/jiti.cjs'));
const log = event => fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ ...event, pid: process.pid, at: Date.now() }) + '\n');
const state = () => JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
const save = value => fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(value));
(async () => {
  const mod = await createJiti(__filename).import(path.join(__dirname, '../index.ts'));
  const spec = mod.SPECS.find(s => s.alias === target);
  const [provider, id] = spec.key.split('/');
  const events = {}, commands = {};
  const ctx = { hasUI: true, model: { provider, id }, ui: { notify: text => log({ type: 'notice', text }), setStatus: () => {} } };
  const pi = { events: { on: () => {} }, on: (name, handler) => events[name] = handler, registerCommand: (name, command) => commands[name] = command };
  mod.createBackendExtension(pi, {
    pollMs: 0, readyPollMs: 15,
    ready: async s => { const v = state(); return v.active === s.alias && v.ready; },
    running: async () => { const v = state(); return mod.SPECS.filter(s => s.alias === v.active); },
    launch: (s, stop) => {
      log({ type: stop ? 'stop' : 'launch', alias: s.alias });
      if (stop) { save({ active: null, ready: false }); return { done: Promise.resolve(0), log: 'fixture' }; }
      // Simulate the gap before Docker can detect the container, then readiness
      // before the launcher has actually exited.
      const done = new Promise(resolve => {
        setTimeout(() => save({ active: s.alias, ready: false }), 200);
        setTimeout(() => save({ active: s.alias, ready: true }), 500);
        setTimeout(() => { log({ type: 'launcherDone', alias: s.alias }); resolve(0); }, 800);
      });
      return { done, log: 'fixture' };
    },
  });
  log({ type: 'begin', action, alias: target });
  if (action === 'auto') await events.before_agent_start({}, ctx);
  else await commands.backend.handler(`${action} ${target}`, ctx);
  log({ type: 'complete', action, alias: target });
})().catch(error => { console.error(error); process.exitCode = 1; });
