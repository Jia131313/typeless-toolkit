const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'manager.html'), 'utf8');

function group(name) {
  const start = html.indexOf(`<div class="tool-group ${name}">`);
  assert.notEqual(start, -1, `${name} group must exist`);
  const end = html.indexOf('</div>', start);
  return html.slice(start, end);
}

test('keeps registration and current-account collection on home without device reset', () => {
  const primary = group('primary-tools');
  const system = group('system-tools');
  assert.doesNotMatch(primary, /addAccount\(\)|resetDeviceOnly\(\)/);
  assert.doesNotMatch(system, /resetDeviceOnly\(\)/);
  assert.match(system, /注册账号[\s\S]*添加当前账号/);
  assert.ok(system.indexOf('openRegisterWizard()') < system.indexOf('addAccount()'));
});

test('device reset has an explicit destructive confirmation and calls the existing API', () => {
  assert.match(html, /function resetDeviceOnly\(\)[\s\S]*确认重置本机 Typeless 设备标识/);
  assert.match(html, /resetDeviceOnly\(\)[\s\S]*apiTimed\('\/api\/reset-device',\{method:'POST'\},60000\)/);
});

test('opens account collection when the manually detected account is not managed', () => {
  assert.match(html, /if\s*\(manual\)\s*addAccount\(\)/);
});

test('guides managed legacy accounts through credential recapture', () => {
  assert.match(html, /credentialNeedsUpdate\s*=\s*live\.credential_state\s*===\s*['"]legacy['"]/);
  assert.match(html, /if\s*\(manual\s*&&\s*matched\.live\?\.credential_state\s*===\s*['"]legacy['"]\)\s*addAccount\(\)/);
});

test('renders effective login lifetime and a direct empty-state action', () => {
  assert.match(html, /credential_days_left/);
  assert.match(html, /登录有效期/);
  assert.match(html, /还没有账号[\s\S]*onclick="addAccount\(\)"[\s\S]*添加当前账号/);
});

test('submits refresh credentials captured from Typeless', () => {
  assert.match(html, /refresh_token\s*:\s*d\.refresh_token/);
  assert.match(html, /client_user_id\s*:\s*d\.client_user_id/);
});

test('offers encrypted WebDAV account sync with a Nutstore preset', () => {
  assert.match(html, /账号同步/);
  assert.match(html, /value="nutstore"[^>]*>坚果云/);
  assert.match(html, /openAccountSync\(\)/);
  assert.match(html, /\/api\/account-sync\/config/);
  assert.match(html, /\/api\/account-sync\/test/);
  assert.match(html, /\/api\/account-sync\/run/);
});

test('cloud-only accounts can be activated on the current device', () => {
  assert.match(html, /a\.cloud_only/);
  assert.match(html, /activateAccount\('\$\{a\.user_id\}'\)/);
  assert.match(html, /在此设备启用/);
  assert.match(html, /\/activate/);
});
