const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const {
  API_HOST,
  shouldSignApiPath,
  readAsarEntry,
  extractSignatureKeys,
  evpBytesToKey,
  aesEncryptOpenSSL,
  hmacSha1Hex,
  buildSignatureHeaders,
} = require('../lib/typeless-api-security');

// 测试专用假密钥,与真实密钥无关
const FAKE_VN = 'a'.repeat(56);
const FAKE_EU = 'b'.repeat(56);

/** 按 asar 的实际布局拼一个最小归档,用于验证读取偏移 */
function buildAsar(entries) {
  const header = { files: {} };
  const blobs = [];
  let offset = 0;
  for (const [p, content] of Object.entries(entries)) {
    const buf = Buffer.from(content, 'utf8');
    const parts = p.split('/').filter(Boolean);
    let node = header;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.files[parts[i]]) node.files[parts[i]] = { files: {} };
      node = node.files[parts[i]];
    }
    node.files[parts[parts.length - 1]] = { size: buf.length, offset: String(offset) };
    blobs.push(buf);
    offset += buf.length;
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const headerBuf = Buffer.alloc(8 + json.length + pad);
  headerBuf.writeUInt32LE(4 + json.length + pad, 0);
  headerBuf.writeUInt32LE(json.length, 4);
  json.copy(headerBuf, 8);
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerBuf.length, 4);
  return Buffer.concat([prefix, headerBuf, ...blobs]);
}

/** 模拟官方 2.7.0 主进程 bundle 的关键结构(池 + 索引取值 + 平台前缀) */
function fakeMainBundle(over = {}) {
  const host = over.host || API_HOST;
  const pool = [host, 'unused', over.version || '2.7.0', over.vn || FAKE_VN, over.eu || FAKE_EU, over.env || 'prod'];
  const literal = '[' + pool.map(v => `'${v}'`).join(',') + ']';
  return [
    `const pool=${literal};`,
    `const sr='${over.prefix || 'win_'}';`,
    `const Li=_0xF(0x0),ku='https://www.typeless.com',ns=_0xF(0x2),vn=_0xF(0x3),Eu=_0xF(0x4),Di=_0xF(0x5),tr=Di!=='prod';`,
    `function _0xF(i){return pool[i];}`,
  ].join('\n');
}

function fakeAsar(over) {
  return buildAsar({ '/dist/main/index.js': fakeMainBundle(over) });
}

/** API host / prod 内联,官网地址和平台前缀位于可旋转的字符串池中 */
function fakeInlineAsar({ version = '2.7.0', prefix = 'mac_', rotation = 0, base = 0x100, vn = FAKE_VN, eu = FAKE_EU } = {}) {
  const pool = [version, vn, eu, 'prod', prefix, 'https://www.typeless.com', 'unused'];
  const rotated = pool.slice(rotation).concat(pool.slice(0, rotation));
  const literal = '[' + rotated.map(v => `'${v}'`).join(',') + ']';
  const index = i => '0x' + (base + i).toString(16);
  const src = [
    `const pool=${literal};`,
    `const host='${API_HOST}',site=decode(${index(5)}),release=decode(${index(0)}),name='Typeless',secretA=decode(${index(1)}),secretB=decode(${index(2)}),environment='prod',dev=environment!==decode(${index(3)});`,
    `const platform=lookup(${index(4)});const appVersion=platform+release['split']('-')[0];`,
  ].join('\n');
  return buildAsar({ '/dist/main/index.js': src });
}

/** 用测试口令解开 X-Authorization,核对官方载荷字段 */
function decryptPayload(xAuth) {
  const raw = Buffer.from(xAuth, 'base64');
  const { key, iv } = evpBytesToKey(FAKE_VN, raw.subarray(8, 16), 32, 16);
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return JSON.parse(Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8'));
}

const TEST_KEYS = {
  aesPassphrase: FAKE_VN, hmacSecret: FAKE_EU,
  appVersion: '2.7.0', platformPrefix: 'win_', xEnv: 'prod',
};

test('刷新接口豁免签名,业务接口需要签名', () => {
  assert.equal(shouldSignApiPath('/oauth/refresh_access_token'), false);
  assert.equal(shouldSignApiPath('/user/get_user_info'), true);
  assert.equal(shouldSignApiPath('/user/dictionary/list?size=500'), true);
  assert.equal(shouldSignApiPath(''), false);
});

test('readAsarEntry 按 header 偏移取出文件内容', () => {
  const asar = buildAsar({
    '/dist/main/index.js': 'hello main',
    '/package.json': '{"version":"2.7.0"}',
  });
  assert.equal(readAsarEntry(asar, '/dist/main/index.js').toString('utf8'), 'hello main');
  assert.equal(readAsarEntry(asar, '/package.json').toString('utf8'), '{"version":"2.7.0"}');
  assert.equal(readAsarEntry(asar, '/dist/main/missing.js'), null);
});

test('从主进程 bundle 还原签名参数', () => {
  const keys = extractSignatureKeys(fakeAsar());
  assert.equal(keys.aesPassphrase, FAKE_VN);
  assert.equal(keys.hmacSecret, FAKE_EU);
  assert.equal(keys.appVersion, '2.7.0');
  assert.equal(keys.platformPrefix, 'win_');
  assert.equal(keys.xEnv, 'prod');
  assert.equal(keys.offset, 0);
});

test('macOS 前缀同样可还原', () => {
  const keys = extractSignatureKeys(fakeAsar({ prefix: 'mac_' }));
  assert.equal(keys.platformPrefix, 'mac_');
  assert.equal(keys.appVersion, '2.7.0');
});

test('内联配置不依赖具体版本、平台或字符串池偏移', () => {
  for (const version of ['2.7.0', '2.8.12-beta.1']) {
    for (const prefix of ['mac_', 'win_']) {
      for (const rotation of [0, 3, 5]) {
        for (const base of [0, 0x100]) {
          const keys = extractSignatureKeys(fakeInlineAsar({ version, prefix, rotation, base }));
          assert.equal(keys.aesPassphrase, FAKE_VN);
          assert.equal(keys.hmacSecret, FAKE_EU);
          assert.equal(keys.appVersion, version);
          assert.equal(keys.platformPrefix, prefix);
          assert.equal(keys.xEnv, 'prod');
          const headers = buildSignatureHeaders({ url: API_HOST + '/user/get_user_info', userId: 'u-1', keys });
          assert.equal(headers['X-App-Version'], prefix + version.split('-')[0]);
          assert.equal(decryptPayload(headers['X-Authorization'])['X-Env'], 'prod');
        }
      }
    }
  }
});

test('内联配置的密钥、平台和版本仍需通过校验', () => {
  for (const over of [{ vn: 'invalid' }, { eu: 'invalid' }]) {
    assert.throws(() => extractSignatureKeys(fakeInlineAsar(over)), /不合法/);
  }
  assert.throws(() => extractSignatureKeys(fakeInlineAsar({ prefix: 'linux_' })), /平台前缀/);
  assert.throws(() => extractSignatureKeys(fakeInlineAsar({ version: 'unknown' })), /版本号/);
});

test('X-Env 自校验不通过时拒绝返回密钥', () => {
  assert.throws(() => extractSignatureKeys(fakeAsar({ env: 'dev' })), /校准失败/);
});

test('密钥形态不合法时拒绝返回', () => {
  assert.throws(() => extractSignatureKeys(fakeAsar({ vn: 'not-a-hex-key' })), /不合法/);
});

test('bundle 结构不符时给出明确错误', () => {
  const asar = buildAsar({ '/dist/main/index.js': 'const nothing = 1;' });
  assert.throws(() => extractSignatureKeys(asar), /定位签名参数声明/);
});

test('bundle 内缺少主进程文件时报错', () => {
  const asar = buildAsar({ '/package.json': '{}' });
  assert.throws(() => extractSignatureKeys(asar), /未找到主进程/);
});

test('EVP_BytesToKey 派生结果稳定', () => {
  const salt = Buffer.from('0001020304050607', 'hex');
  assert.equal(
    evpBytesToKey('test-passphrase-123', salt, 32, 16).key.toString('hex'),
    '7255e86ca6755070b97ccea2a9220fa077c1c3fb3e72821d5f874c670ab9fc16'
  );
});

// 固定 salt 的已知向量,该向量已用官方 crypto-js 验证可正确解密
test('AES 输出为 OpenSSL salted 格式且可由 crypto-js 还原', () => {
  const salt = Buffer.from('0001020304050607', 'hex');
  const out = aesEncryptOpenSSL('hello typeless', 'test-passphrase-123', salt);
  assert.equal(out, 'U2FsdGVkX18AAQIDBAUGBztJ9Y/p0Njqyes0giPM74k=');
  const raw = Buffer.from(out, 'base64');
  assert.equal(raw.subarray(0, 8).toString('utf8'), 'Salted__');
  assert.deepEqual(raw.subarray(8, 16), salt);
});

test('AES 口令错误时无法还原出等价明文', () => {
  const salt = Buffer.from('0001020304050607', 'hex');
  const a = aesEncryptOpenSSL('same text', 'pass-a', salt);
  const b = aesEncryptOpenSSL('same text', 'pass-b', salt);
  assert.notEqual(a, b);
});

test('HMAC-SHA1 输出十六进制摘要', () => {
  assert.equal(
    hmacSha1Hex('1758000000000:win_2.7.0:/user/get_user_info:u-1', '1758000000000:secret'),
    '2e0477933af3c1ef1ae8d4403dd8a1a377c0dde0'
  );
});

test('构造的签名头字段齐全且版本前缀正确', () => {
  const keys = TEST_KEYS;
  const h = buildSignatureHeaders({
    url: 'https://api.typeless.com/user/get_user_info',
    userId: 'u-1', keys, now: 1758000000000, randomInt: 123456,
  });
  assert.equal(h['X-App-Version'], 'win_2.7.0');
  assert.equal(h['X-Browser-Name'], 'unknown');
  assert.equal(h['X-Browser-Version'], 'unknown');
  assert.equal(h['X-Browser-Major'], 'unknown');
  assert.match(h['X-Authorization'], /^U2FsdGVkX1/);
});

test('签名串取 pathname 并丢弃 query', () => {
  // 每次加密 salt 随机,所以要比对解开的签名值而不是密文本身
  const withQuery = buildSignatureHeaders({
    url: `${API_HOST}/user/dictionary/list?size=500&offset=100`,
    userId: 'u-1', keys: TEST_KEYS, now: 1758000000000, randomInt: 1,
  });
  const noQuery = buildSignatureHeaders({
    url: `${API_HOST}/user/dictionary/list`,
    userId: 'u-1', keys: TEST_KEYS, now: 1758000000000, randomInt: 1,
  });
  assert.equal(decryptPayload(withQuery['X-Authorization']).p,
               decryptPayload(noQuery['X-Authorization']).p);
});

test('加密载荷内的 t/p 与签名串一致', () => {
  const now = 1758000000000;
  const h = buildSignatureHeaders({
    url: `${API_HOST}/user/get_user_info`,
    userId: 'u-1', keys: TEST_KEYS, now, randomInt: 654321,
  });
  const payload = decryptPayload(h['X-Authorization']);

  assert.equal(payload['X-Env'], 'prod');
  assert.equal(payload['t'], now);
  assert.equal(payload['X-Random'], '654321');
  assert.equal(payload['d'], 'UNKNOWN');
  assert.equal(
    payload['p'],
    hmacSha1Hex(`${now}:win_2.7.0:/user/get_user_info:u-1`, `${now}:${FAKE_EU}`)
  );
});

test('缺少 userId 或密钥时拒绝构造', () => {
  const keys = TEST_KEYS;
  assert.throws(() => buildSignatureHeaders({ url: API_HOST, userId: '', keys }), /userId/);
  assert.throws(() => buildSignatureHeaders({ url: API_HOST, userId: 'u', keys: null }), /密钥/);
});

// 本机装了 Typeless 时顺带验证真实包;CI 等无安装环境自动跳过
test('本机真实 app.asar 可还原出可用密钥', t => {
  const asarPath = process.env.TYPELESS_ASAR_FOR_TEST;
  if (!asarPath || !fs.existsSync(asarPath)) return t.skip('未设置 TYPELESS_ASAR_FOR_TEST');
  const keys = extractSignatureKeys(fs.readFileSync(asarPath));
  assert.match(keys.aesPassphrase, /^[0-9a-f]{32,128}$/);
  assert.match(keys.hmacSecret, /^[0-9a-f]{32,128}$/);
  assert.equal(keys.xEnv, 'prod');
  assert.match(keys.platformPrefix, /^(win_|mac_)$/);
  assert.match(keys.appVersion, /^\d+\.\d+/);
});
