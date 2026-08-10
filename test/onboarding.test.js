const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('onboarding repair completes both live files and the current account snapshot', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typeless-onboarding-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'toolkit-data');
  const userData = path.join(root, 'typeless-user-data');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({
    typeless_exe: '/usr/bin/true',
    userdata_dir: userData,
  }));
  fs.writeFileSync(path.join(userData, 'app-onboarding.json'), JSON.stringify({ isCompleted: true }));
  fs.writeFileSync(path.join(userData, 'app-storage.json'), JSON.stringify({
    userData: { user_id: 'fixture-user', onboarding: {} },
  }));

  const script = `
    const fs = require('fs');
    const path = require('path');
    const C = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'common.js'))});
    const before = C.checkOnboardingStatus();
    C.applyOnboardingCompleteToLiveFiles();
    C.saveSnapshot('fixture-user');
    const complete = C.checkOnboardingStatus();
    const profile = path.join(C.PROFILES_DIR, 'fixture-user');
    fs.writeFileSync(path.join(profile, 'app-onboarding.json'), JSON.stringify({ isCompleted: false }));
    fs.writeFileSync(path.join(profile, 'app-storage.json'), JSON.stringify({ userData: { user_id: 'fixture-user', onboarding: {} } }));
    C.restoreSnapshot('fixture-user');
    const repaired = C.healOnboardingAfterRestore('fixture-user');
    const after = C.checkOnboardingStatus();
    process.stdout.write(JSON.stringify({ before, complete, repaired, after }));
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TYPELESS_DATA_DIR: dataRoot },
  });
  const result = JSON.parse(output);

  assert.equal(result.before.completed, false);
  assert.equal(result.before.local_completed, false);
  assert.equal(result.complete.completed, true);
  assert.equal(result.complete.snapshot_completed, true);
  assert.equal(result.repaired.healed, true);
  assert.equal(result.after.completed, true);
  assert.equal(result.after.local_completed, true);
  assert.equal(result.after.storage_completed, true);
  assert.equal(result.after.snapshot_completed, true);
});
