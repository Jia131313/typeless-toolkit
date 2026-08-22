const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

process.env.TYPELESS_MANAGER_PORT = '17889';
const { createDictionarySyncController } = require('../manager');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('automatic dictionary sync debounces changes and exposes aligned status', async t => {
  let calls = 0;
  const controller = createDictionarySyncController(async () => {
    calls++;
    return {
      results: [], master_count: 12, account_count: 2,
      aligned_count: 2, failed_count: 0, all_aligned: true,
      msg: '全部账号已对齐',
    };
  }, { startupDelayMs: 1000, intervalMs: 60_000, debounceMs: 5 });
  t.after(() => controller.stop());

  controller.schedule('account-added');
  controller.schedule('master-edited');
  await delay(30);

  assert.equal(calls, 1);
  assert.equal(controller.status().state, 'aligned');
  assert.equal(controller.status().summary.master_count, 12);
  assert.deepEqual(controller.status().reasons.sort(), ['account-added', 'master-edited']);
});

test('automatic dictionary sync keeps one in-flight job and queues mutations once', async t => {
  let calls = 0;
  let release;
  const firstGate = new Promise(resolve => { release = resolve; });
  const controller = createDictionarySyncController(async () => {
    calls++;
    if (calls === 1) await firstGate;
    return {
      results: [], master_count: 1, account_count: 1,
      aligned_count: 1, failed_count: 0, all_aligned: true, msg: '已对齐',
    };
  }, { startupDelayMs: 1000, intervalMs: 60_000, debounceMs: 5 });
  t.after(() => controller.stop());

  const running = controller.run('manual');
  await delay(5);
  controller.schedule('word-added');
  controller.schedule('word-deleted');
  assert.equal(calls, 1);
  release();
  await running;
  await delay(30);

  assert.equal(calls, 2);
  assert.equal(controller.status().state, 'aligned');
});

test('explicit dictionary deletions persist as tombstones until explicitly re-added', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typeless-dictionary-sync-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ typeless_exe: '/usr/bin/true' }));

  const script = `
    const C = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'common.js'))});
    C.writeMaster(['Alpha', 'Beta']);
    C.recordDictionaryDeletions(['Alpha'], 'test');
    const afterDelete = { master: C.readMaster(), meta: C.readDictionarySyncMeta() };
    const restored = C.replaceMasterTerms(['Alpha', 'Beta']);
    const afterRestore = { master: C.readMaster(), meta: C.readDictionarySyncMeta(), restored };
    const removedAgain = C.replaceMasterTerms(['Beta']);
    const final = { master: C.readMaster(), meta: C.readDictionarySyncMeta(), removedAgain };
    process.stdout.write(JSON.stringify({ afterDelete, afterRestore, final }));
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TYPELESS_DATA_DIR: root },
  });
  const result = JSON.parse(output);

  assert.deepEqual(result.afterDelete.master, ['Beta']);
  assert.equal(result.afterDelete.meta.tombstones.alpha.term, 'Alpha');
  assert.deepEqual(result.afterRestore.master, ['Alpha', 'Beta']);
  assert.equal(result.afterRestore.meta.tombstones.alpha, undefined);
  assert.deepEqual(result.final.master, ['Beta']);
  assert.equal(result.final.meta.tombstones.alpha.source, 'master-edit');
  assert.deepEqual(result.final.removedAgain.removed, ['Alpha']);
});
