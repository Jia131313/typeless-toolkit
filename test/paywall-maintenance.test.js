const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

process.env.TYPELESS_MANAGER_PORT = '17890';
const { createPaywallMaintenanceController } = require('../manager');

test('automatic paywall maintenance skips an already patched app', async t => {
  let repairs = 0;
  const controller = createPaywallMaintenanceController(
    () => ({ exists: true, patched: true }),
    async () => { repairs++; },
    () => true,
    { intervalMs: 60_000, startupDelayMs: 60_000 }
  );
  t.after(() => controller.stop());

  const outcome = await controller.run('startup');

  assert.equal(outcome.ok, true);
  assert.equal(outcome.skipped, true);
  assert.equal(repairs, 0);
  assert.equal(controller.status().state, 'patched');
});

test('automatic paywall maintenance repairs a missing patch after a controlled workflow', async t => {
  let repairs = 0;
  const controller = createPaywallMaintenanceController(
    () => ({ exists: true, patched: false, autoDetected: [['from', 'to']] }),
    async ({ reason }) => {
      repairs++;
      return { done: true, reason };
    },
    () => true,
    { intervalMs: 60_000, startupDelayMs: 60_000 }
  );
  t.after(() => controller.stop());

  const outcome = await controller.run('account-switch');

  assert.equal(outcome.ok, true);
  assert.equal(repairs, 1);
  assert.equal(outcome.result.reason, 'account-switch');
  assert.equal(controller.status().state, 'patched');
  assert.equal(controller.status().msg, '弹窗已自动解除');
});

test('periodic maintenance defers an intrusive repair while Typeless is active', async t => {
  let repairs = 0;
  const controller = createPaywallMaintenanceController(
    () => ({ exists: true, patched: false }),
    async () => { repairs++; },
    () => true,
    { intervalMs: 60_000, startupDelayMs: 60_000 }
  );
  t.after(() => controller.stop());

  const outcome = await controller.run('periodic');

  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'TYPELESS_BUSY');
  assert.equal(repairs, 0);
  assert.equal(controller.status().state, 'deferred');
});

test('periodic maintenance avoids reparsing an unchanged app bundle', async t => {
  let statusReads = 0;
  const controller = createPaywallMaintenanceController(
    () => { statusReads++; return { exists: true, patched: true }; },
    async () => ({ done: true }),
    () => true,
    {
      intervalMs: 60_000,
      startupDelayMs: 60_000,
      fingerprintFn: () => 'same-app-asar',
    }
  );
  t.after(() => controller.stop());

  await controller.run('startup');
  const periodic = await controller.run('periodic');

  assert.equal(statusReads, 1);
  assert.equal(periodic.code, 'ARTIFACT_UNCHANGED');
  assert.equal(controller.status().state, 'patched');
});

test('App Management failures become a resumable permission state', async t => {
  const controller = createPaywallMaintenanceController(
    () => ({ exists: true, patched: false }),
    async () => {
      const error = new Error('需要开启 App 管理');
      error.code = 'APP_MANAGEMENT_REQUIRED';
      error.permission = { regrant_required: true };
      throw error;
    },
    () => false,
    { intervalMs: 60_000, startupDelayMs: 60_000 }
  );
  t.after(() => controller.stop());

  const outcome = await controller.run('startup');

  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'APP_MANAGEMENT_REQUIRED');
  assert.equal(controller.status().state, 'permission-required');
  assert.equal(controller.status().permission.regrant_required, true);
});

test('successful App Management use clears the current Toolkit identity marker', {
  skip: process.platform !== 'darwin',
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typeless-permission-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ typeless_exe: '/usr/bin/true' }));
  fs.writeFileSync(path.join(root, 'mac-permission-identity.json'), JSON.stringify({
    requirement: 'designated => cdhash H"fixture"',
    app_management_regrant_required: true,
  }));

  const script = `
    const C = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'common.js'))});
    const before = C.toolkitAppManagementState();
    const after = C.markToolkitAppManagementAuthorized();
    process.stdout.write(JSON.stringify({ before, after }));
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TYPELESS_DATA_DIR: root },
  });
  const result = JSON.parse(output);

  assert.equal(result.before.regrant_required, true);
  assert.equal(result.after.regrant_required, false);
  assert.match(result.after.authorized_at, /^\d{4}-\d{2}-\d{2}T/);
});
