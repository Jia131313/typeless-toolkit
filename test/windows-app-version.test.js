'use strict';
/**
 * Windows 客户端版本号读取与签名错误文案。
 *
 * 回归背景:Typeless 2.10.0 的字符串池里同时留着 2.8.0 和 2.10.0 两个字面量。
 * Windows 分支的 platform 没有实现 appVersion(),common.js 传空串进去,
 * extractSignatureKeys 于是回落到池里第一个版本号 2.8.0。签名头
 * X-App-Version 带错版本,服务端返回 101010100,刷新凭证全部失败。
 * 同时服务端把 detail 返回成对象,String() 之后界面上只剩「[object Object]」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.TYPELESS_EXE = path.join(__dirname, 'no-such-typeless.exe');
const { describeApiError } = require('../lib/common');
const P = require('../lib/platform');

// 下面三条针对 Windows 分支。CI 的 macOS job 里 P.platform 是 mac 实现,
// appVersion 走 plutil 读 Info.plist,错误信息与断言不符,必须跳过。
const WIN_ONLY = { skip: process.platform !== 'win32' };

test('Windows 平台提供 appVersion,与 macOS 分支对齐', WIN_ONLY, () => {
  assert.equal(typeof P.platform.appVersion, 'function');
});

test('appVersion 拒绝空路径,不会静默返回空串', WIN_ONLY, () => {
  assert.throws(() => P.platform.appVersion(''), /未指定/);
});

test('appVersion 对不存在的文件给出明确错误', WIN_ONLY, () => {
  assert.throws(
    () => P.platform.appVersion(path.join(__dirname, 'no-such-typeless.exe')),
    /不存在/,
  );
});

test('签名错误文案能吃下对象形态的 detail', () => {
  // 服务端对签名不匹配的实际返回:detail 是对象而不是字符串
  const serverDetail = {
    ja3_tls_code: 101010100,
    details: null,
    msg: 'Request failed due to a client-side error (code: 101010100).',
  };
  const text = describeApiError(serverDetail);
  assert.equal(text, serverDetail.msg);
  assert.doesNotMatch(text, /\[object Object\]/);
});

test('describeApiError 保留字符串与兜底形态', () => {
  assert.equal(describeApiError('This client is not supported.'), 'This client is not supported.');
  assert.equal(describeApiError({ code: 1 }), '{"code":1}');
  assert.equal(describeApiError({ message: 'inner' }), 'inner');
  assert.equal(describeApiError(null), '');
  assert.equal(describeApiError(undefined), '');
  assert.equal(describeApiError(''), '');
});

test('describeApiError 按上限截断超长内容', () => {
  const long = 'x'.repeat(500);
  assert.equal(describeApiError(long, 50).length, 50);
  assert.ok(describeApiError({ msg: long }, 50).length <= 50);
});
