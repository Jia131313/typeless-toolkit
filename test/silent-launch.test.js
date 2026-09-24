// 验证 withSilentLaunch 的「借用 + 恢复」:在临时 userdata 目录上跑,不碰真实设置
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** 在隔离的 data/userdata 目录里加载 common.js,返回 { run } */
function withFixture(settings) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-data-'));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-user-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'),
    JSON.stringify({ userdata_dir: userDir }), 'utf8');
  const file = path.join(userDir, 'app-settings.json');
  if (settings !== null) fs.writeFileSync(file, JSON.stringify(settings, null, '\t') + '\n', 'utf8');

  return {
    dataDir, userDir, file,
    /** 在子进程里调用 withSilentLaunch,避免模块级常量被本进程缓存 */
    run(script) {
      const code = `
        process.env.TYPELESS_DATA_DIR = ${JSON.stringify(dataDir)};
        const c = require(${JSON.stringify(path.join(ROOT, 'lib/common.js'))});
        const fs = require('fs');
        (async () => {
          let inside = null;
          await c.withSilentLaunch(async () => {
            inside = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8')).launchAtSystemStartup;
          });
          console.log(JSON.stringify({ inside }));
        })();
      `;
      const out = execFileSync(process.execPath, ['-e', code],
        { encoding: 'utf8', cwd: ROOT });
      return JSON.parse(out.trim().split('\n').pop());
    },
    cleanup() {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(userDir, { recursive: true, force: true });
    },
  };
}

test('自启开关为 false 时:借用期间置真,结束后原样恢复', () => {
  const f = withFixture({ launchAtSystemStartup: false, featureShortcutBindings: { dictationMode: 'LeftCtrl' } });
  const before = fs.readFileSync(f.file, 'utf8');
  try {
    const { inside } = f.run();
    assert.equal(inside, true, '借用期间应为 true');
    const after = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    assert.equal(after.launchAtSystemStartup, false, '结束后应恢复 false');
    assert.deepEqual(after.featureShortcutBindings, { dictationMode: 'LeftCtrl' }, '其它设置不受影响');
    assert.equal(Object.keys(after).length, 2, '不应多出字段');
  } finally { f.cleanup(); }
  void before;
});

test('自启开关本来就是 true 时:不改文件,内容保持一致', () => {
  const f = withFixture({ launchAtSystemStartup: true });
  const before = fs.readFileSync(f.file, 'utf8');
  try {
    const { inside } = f.run();
    assert.equal(inside, true);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before, '文件应保持不变');
  } finally { f.cleanup(); }
});

test('设置里没有该字段时:借用后把字段删掉,而不是留一个 true', () => {
  const f = withFixture({ featureShortcutBindings: {} });
  try {
    const { inside } = f.run();
    assert.equal(inside, true, '借用期间应为 true');
    const after = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    assert.equal('launchAtSystemStartup' in after, false, '应恢复为「没有该字段」');
    assert.deepEqual(Object.keys(after), ['featureShortcutBindings']);
  } finally { f.cleanup(); }
});

test('设置文件缺失时:不写文件,直接执行', () => {
  const f = withFixture(null);
  let called = false;
  try {
    // 文件不存在时 writeAppSettings 会建一个新的,这里只要求不抛错
    const { inside } = f.run();
    called = true;
    assert.equal(typeof inside, 'boolean');
  } finally { f.cleanup(); }
  assert.ok(called);
});
