/**
 * 隔离浏览器登录：leveldb 解析与 profile 生命周期的单元测试。
 *
 * 用真实的 Chrome local storage 结构做 fixture——leveldb 的物理格式不需要
 * 完整实现，只需要「键和值连在一段字节流里」这个特征，解析器就是按这个特征工作的。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const browserLogin = require('../lib/browser-login');

// 造一个最小可用的 access token（只要求 JWT 结构和 subject.user_id）
function makeToken(userId, type = 'access', expSeconds = Math.floor(Date.now() / 1000) + 3600) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ subject: { user_id: userId }, type, exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function makeTempProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-browser-login-test-'));
  const leveldb = path.join(root, 'Default', 'Local Storage', 'leveldb');
  fs.mkdirSync(leveldb, { recursive: true });
  return { root, leveldb };
}

// 按 leveldb 的物理布局写一条记录：0x00 前缀 + 键 + 0x01 + 值长度 + 值
function writeLeveldbRecord(file, key, value) {
  const valueBuf = Buffer.from(JSON.stringify(value), 'utf8');
  const keyBuf = Buffer.from(key, 'latin1');
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32LE(valueBuf.length, 0);
  const record = Buffer.concat([
    Buffer.from([0x00]), keyBuf, Buffer.from([0x01]),
    lengthBuf, valueBuf,
  ]);
  fs.appendFileSync(file, record);
}

test('能从 leveldb 记录里读出 access/refresh token', () => {
  const { root, leveldb } = makeTempProfile();
  const userId = '11111111-2222-3333-4444-555555555555';
  const value = {
    accessToken: makeToken(userId, 'access'),
    refreshToken: makeToken(userId, 'refresh', Math.floor(Date.now() / 1000) + 86400),
    userId,
    email: 'new@example.com',
  };
  writeLeveldbRecord(path.join(leveldb, '000001.ldb'), browserLogin.TOKEN_KEY, value);

  const token = browserLogin.readTokenFromProfile(root);
  assert.ok(token, '应读到凭证');
  assert.strictEqual(token.email, 'new@example.com');
  assert.strictEqual(browserLogin.tokenUserId(token.accessToken), userId);
  assert.ok(token.refreshToken.startsWith('ey'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('没有登录记录时返回 null', () => {
  const { root } = makeTempProfile();
  assert.strictEqual(browserLogin.readTokenFromProfile(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('只有埋点类 localStorage 记录时不会误判为已登录', () => {
  const { root, leveldb } = makeTempProfile();
  writeLeveldbRecord(
    path.join(leveldb, '000002.ldb'),
    'TYPELESS_CLIENT__FEATURES__USER__CLIENT_USER_ID',
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  );
  assert.strictEqual(browserLogin.readTokenFromProfile(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('waitForNewToken 会跳过原账号，等到新账号出现', async () => {
  const { root, leveldb } = makeTempProfile();
  const file = path.join(leveldb, '000003.log');
  const oldId = '99999999-8888-7777-6666-555555555555';
  writeLeveldbRecord(file, browserLogin.TOKEN_KEY, {
    accessToken: makeToken(oldId),
    refreshToken: makeToken(oldId, 'refresh'),
    userId: oldId,
    email: 'old@example.com',
  });

  const newId = 'aaaaaaaa-1111-2222-3333-444444444444';
  const newValue = {
    accessToken: makeToken(newId),
    refreshToken: makeToken(newId, 'refresh'),
    userId: newId,
    email: 'fresh@example.com',
  };
  // 350ms 后追加新账号记录，模拟用户在浏览器里完成注册
  setTimeout(() => writeLeveldbRecord(file, browserLogin.TOKEN_KEY, newValue), 350);

  const hit = await browserLogin.waitForNewToken(root, oldId, 5000, 100);
  assert.ok(hit, '应等到新账号');
  assert.strictEqual(hit.userId, newId);
  assert.strictEqual(hit.token.email, 'fresh@example.com');

  fs.rmSync(root, { recursive: true, force: true });
});

test('waitForNewToken 在原账号会一直等待直到超时', async () => {
  const { root, leveldb } = makeTempProfile();
  const oldId = '77777777-6666-5555-4444-333333333333';
  writeLeveldbRecord(path.join(leveldb, '000004.ldb'), browserLogin.TOKEN_KEY, {
    accessToken: makeToken(oldId),
    refreshToken: makeToken(oldId, 'refresh'),
    userId: oldId,
    email: 'old@example.com',
  });

  const hit = await browserLogin.waitForNewToken(root, oldId, 500, 100);
  assert.strictEqual(hit, null);

  fs.rmSync(root, { recursive: true, force: true });
});

test('cleanupOldProfiles 只删超过时限的目录', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-browser-cleanup-'));
  const root = path.join(dataDir, 'browser-login');
  fs.mkdirSync(root, { recursive: true });
  const oldDir = path.join(root, 'profile-old');
  const newDir = path.join(root, 'profile-new');
  fs.mkdirSync(oldDir);
  fs.mkdirSync(newDir);
  const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.utimesSync(oldDir, longAgo, longAgo);

  const removed = browserLogin.cleanupOldProfiles(dataDir, 24 * 60 * 60 * 1000);
  assert.strictEqual(removed, 1);
  assert.strictEqual(fs.existsSync(oldDir), false);
  assert.strictEqual(fs.existsSync(newDir), true);

  fs.rmSync(dataDir, { recursive: true, force: true });
});
