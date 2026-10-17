const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const install = path.join(os.homedir(), '.pi/agent/install');
const version = fs.readFileSync(path.join(install, 'current-version'), 'utf8').trim();
const { createJiti } = require(path.join(install, 'releases', version, 'node_modules/jiti/lib/jiti.cjs'));
(async () => {
  const { withBackendLane } = await createJiti(__filename).import(path.join(__dirname, '../lane-lock.ts'));
  await withBackendLane(Number(process.argv[2]), async () => {
    process.send('acquired');
    if (process.argv[3] === 'hold') await new Promise(() => {});
  });
  process.disconnect();
})().catch(error => { console.error(error); process.exitCode = 1; });
