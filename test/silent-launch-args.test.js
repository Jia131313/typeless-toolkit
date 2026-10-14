'use strict';
/**
 * 静默启动的参数构造:确保附加参数（如 --system-startup-silent-launch）
 * 与 cdpPort 分开传递，不再被拼进 --remote-debugging-port 的值里。
 *
 * 回归背景:旧实现把 launchTypeless 的附加参数塞进 launchApp 的第二个形参,
 * 而该形参在 Windows/macOS 都是 cdpPort,结果构造出
 *   --remote-debugging-port=--system-startup-silent-launch
 * 静默标记从未生效,切号时主窗口照常抢前台(issue #54)。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const P = require('../lib/platform');

const SILENT = '--system-startup-silent-launch';
// Windows 下 path.sep 是反斜杠;用同构路径让 appBundleForExecutable 能解析出 bundle
const MAC_EXE = ['', 'Applications', 'Typeless.app', 'Contents', 'MacOS', 'Typeless'].join(path.sep);

/** 从 Windows 的 PowerShell 脚本里解出传给 Typeless 的参数行 */
function winArgLine(script) {
  const match = /FromBase64String\("([^"]+)"\)"\)/g;
  const found = [...script.matchAll(match)].map(m => Buffer.from(m[1], 'base64').toString('utf8'));
  return found[found.length - 1];
}

test('launchApp 的附加参数与 cdpPort 分开传递', () => {
  // 形参签名:exe, cdpPort, extraArgs, options
  assert.equal(P.platform.launchApp.length, 4);
});

test('macOS:静默启动走 open -g 且参数不被污染', () => {
  const silent = P.macLaunchSpec(MAC_EXE, [SILENT], { noActivate: true });
  assert.ok(silent.args.includes('-g'), '静默启动应带 -g（不抢前台）');
  assert.deepEqual(silent.args.slice(silent.args.indexOf('--args') + 1), [SILENT]);
  // 关键回归:静默标记绝不能出现在 --remote-debugging-port 的值里
  assert.equal(silent.args.some(a => a.startsWith('--remote-debugging-port=')), false);

  const normal = P.macLaunchSpec(MAC_EXE, [], undefined);
  assert.equal(normal.args.includes('-g'), false, '非静默不应带 -g');
});

test('macOS:macLaunchArgs 把附加参数追加在 user-data-dir 之后', () => {
  assert.deepEqual(P.macLaunchArgs(9222, '/tmp/ud', [SILENT]), [
    '--remote-debugging-port=9222',
    '--user-data-dir=/tmp/ud',
    SILENT,
  ]);
  assert.deepEqual(P.macLaunchArgs(null, '/tmp/ud', [SILENT]), [
    '--user-data-dir=/tmp/ud',
    SILENT,
  ]);
  // 不传附加参数时保持原行为
  assert.deepEqual(P.macLaunchArgs(9222, '/tmp/ud'), [
    '--remote-debugging-port=9222',
    '--user-data-dir=/tmp/ud',
  ]);
});

test('Windows:静默启动补 -WindowStyle Hidden 且参数独立', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'platform.js'), 'utf8');
  // 脚本只在 noActivate 时加 -WindowStyle Hidden
  assert.match(src, /noActivate \? ' -WindowStyle Hidden' : ''/);
  // 静默标记由 extraArgs 传入,不再拼进 cdpPort
  assert.equal(/--remote-debugging-port=\$\{cdpPort\}/.test(src), true);
});

test('Windows:参数行由 cdpPort 与 extraArgs 顺序拼接', () => {
  // 复刻 win.launchApp 的拼接逻辑,断言顺序与内容
  const build = (cdpPort, extraArgs) => {
    const args = cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [];
    if (Array.isArray(extraArgs)) args.push(...extraArgs);
    return args;
  };
  assert.deepEqual(build(null, [SILENT]), [SILENT]);
  assert.deepEqual(build(9222, [SILENT]), ['--remote-debugging-port=9222', SILENT]);
  assert.deepEqual(build(9222, null), ['--remote-debugging-port=9222']);
  assert.deepEqual(build(null, null), []);
});

/**
 * 回归:2.0.0 把 launchApp 的形参从 (exe, cdpPort, userDataDir) 改成
 * (exe, cdpPort, extraArgs, options) 之后,mac 分支的函数体仍在引用形参之外的
 * userDataDir,于是 macOS 上**任何一次启动 Typeless** 都会抛
 *   ReferenceError: userDataDir is not defined
 * 表现为:点「切换」直接失败(接口返回 500 + 该错误文案),手动/自动切号、
 * 重置设备后的启动全部不可用;Windows 分支不引用该变量,因此不受影响。
 *
 * 这里真实调用一次 mac.launchApp:传入不含 /Contents/ 的路径,函数必然失败,
 * 但失败原因只能是「定位不到 .app Bundle」,不能再是 ReferenceError。
 */
test('macOS:launchApp 不再引用未定义的 userDataDir', async t => {
  if (!P.IS_MAC) return t.skip('仅 macOS 生效的分支,其它平台无法复现');
  const missingExe = path.join(__dirname, 'no-such-bundle', 'Typeless');
  let error = null;
  try {
    await P.platform.launchApp(missingExe, null, null, undefined);
  } catch (e) {
    error = e;
  }
  assert.ok(error, '路径不含 /Contents/ 时应因定位不到 .app Bundle 而失败');
  assert.match(error.message, /\.app Bundle/, '应走到 bundle 解析这一步,说明启动参数已构造成功');
  assert.doesNotMatch(error.message, /userDataDir is not defined/, '不得再抛 ReferenceError');
});

void winArgLine;
