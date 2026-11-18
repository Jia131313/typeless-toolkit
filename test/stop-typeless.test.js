'use strict';
/**
 * 写 Typeless.exe 前的关闭等待:Windows 上 launchTypeless 只把启动交给 PowerShell 就返回,
 * Typeless 可能在被关闭后才真正起来,必须再次关闭并等程序文件可写。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离运行时数据:不读写仓库根目录或真实数据目录
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'typeless-stop-'));
process.env.TYPELESS_DATA_DIR = dataRoot;
test.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

const { stopTypelessForFileWrite } = require('../lib/common');

// 虚拟时钟:wait 只推进时间,不真正等待
function fakeClock() {
  let t = 0;
  return { now: () => t, wait: async ms => { t += ms; } };
}

test('Typeless 被关闭后又延迟启动时会再次关闭,并等满安静期才返回', async () => {
  const clock = fakeClock();
  // 0ms 在运行;关掉后 400ms 时被延迟启动的 PowerShell 拉起;再次关掉后保持退出
  let running = true;
  let kills = 0;
  const relaunchAt = 400;
  let relaunched = false;
  await stopTypelessForFileWrite({
    quietMs: 1000,
    isRunning: () => {
      if (!relaunched && clock.now() >= relaunchAt) { relaunched = true; running = true; }
      return running;
    },
    kill: () => { kills += 1; running = false; },
    writable: () => !running,
    ...clock,
  });
  assert.equal(kills, 2);
  // 第二次关闭发生在 400ms,之后需连续 1000ms 安静
  assert.ok(clock.now() >= relaunchAt + 1000, `返回过早: ${clock.now()}ms`);
});

test('程序文件被其他程序占用时超时报错,且不会误杀进程', async () => {
  const clock = fakeClock();
  let kills = 0;
  await assert.rejects(
    stopTypelessForFileWrite({
      timeoutMs: 2000,
      isRunning: () => false,
      kill: () => { kills += 1; },
      writable: () => false,
      ...clock,
    }),
    /程序文件被占用/,
  );
  assert.equal(kills, 0);
});

test('quietMs 为 0 且已退出、可写时立即返回', async () => {
  const clock = fakeClock();
  let kills = 0;
  await stopTypelessForFileWrite({
    quietMs: 0,
    isRunning: () => false,
    kill: () => { kills += 1; },
    writable: () => true,
    ...clock,
  });
  assert.equal(kills, 0);
  assert.equal(clock.now(), 0);
});
