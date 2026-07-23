const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TYPELESS_EXE = '/path/that/does/not/exist';
const { termsMissingFrom } = require('../lib/common');

/**
 * 模拟旧版「按账号顺序 sync + 跳过已对齐」的漏灌行为,
 * 以及新版「先并集再统一回灌」应得到的结果。
 */
function simulateOldSyncAll(accountWordLists) {
  let master = [];
  const results = [];
  for (const words of accountWordLists) {
    master = [...new Set([...master, ...words])];
    const missing = termsMissingFrom(master, words);
    // 旧逻辑:对本号立刻回灌,并把当时的 aligned 记下来
    const after = [...new Set([...words, ...missing])];
    results.push({
      before: words.length,
      after: after.length,
      imported: missing.length,
      aligned: termsMissingFrom(master, after).length === 0,
      master_at_time: master.length,
    });
  }
  // 旧第二遍:跳过 aligned
  const finalMaster = master;
  const reallyMissing = results.map((r, i) => ({
    idx: i,
    missing_vs_final: termsMissingFrom(finalMaster, [
      ...accountWordLists[i],
      // 旧逻辑只灌了当时缺的,没有再灌后来扩库的词
      ...termsMissingFrom(
        // 当时 master 前缀
        accountWordLists.slice(0, i + 1).reduce((m, w) => [...new Set([...m, ...w])], []),
        accountWordLists[i],
      ).length
        ? termsMissingFrom(
            accountWordLists.slice(0, i + 1).reduce((m, w) => [...new Set([...m, ...w])], []),
            accountWordLists[i],
          )
        : [],
    ]),
  }));
  return { finalMaster, results, reallyMissing };
}

function simulateNewSyncAll(accountWordLists) {
  // 阶段 1:只并集
  let master = [];
  for (const words of accountWordLists) {
    master = [...new Set([...master, ...words])];
  }
  // 阶段 2:用最终主库回灌
  const results = accountWordLists.map((words) => {
    const missing = termsMissingFrom(master, words);
    const after = [...new Set([...words, ...missing])];
    return {
      before: words.length,
      after: after.length,
      imported: missing.length,
      missing_after: termsMissingFrom(master, after).length,
      aligned: termsMissingFrom(master, after).length === 0,
    };
  });
  return { master, results };
}

test('old ordered sync marks early accounts aligned before master grows', () => {
  // type1-4 词少, type5 贡献新词, type6 在最后收到回灌
  const accounts = [
    ['a', 'b', 'c'],
    ['a', 'b', 'd'],
    ['a', 'e'],
    ['b', 'c'],
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'], // type5 主力号
    ['a', 'b'],
  ];
  const old = simulateOldSyncAll(accounts);
  // 最终主库应包含 type5 的新词
  assert.ok(old.finalMaster.includes('f'));
  assert.ok(old.finalMaster.includes('g'));
  // 旧结果会把前几个标成 aligned(相对当时主库)
  assert.equal(old.results[0].aligned, true);
  assert.equal(old.results[4].aligned, true);
  // 但 type1 相对最终主库其实仍缺 f/g
  const type1FinalMissing = termsMissingFrom(old.finalMaster, [
    ...accounts[0],
    ...termsMissingFrom(
      accounts.slice(0, 1).reduce((m, w) => [...new Set([...m, ...w])], []),
      accounts[0],
    ),
  ]);
  assert.ok(type1FinalMissing.includes('f') || type1FinalMissing.includes('g'));
});

test('new two-phase sync pushes final master to every account', () => {
  const accounts = [
    ['a', 'b', 'c'],
    ['a', 'b', 'd'],
    ['a', 'e'],
    ['b', 'c'],
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    ['a', 'b'],
  ];
  const neu = simulateNewSyncAll(accounts);
  assert.equal(neu.master.length, 7);
  for (const r of neu.results) {
    assert.equal(r.aligned, true);
    assert.equal(r.missing_after, 0);
  }
  // type1 应导入 f/g 等缺词,不只是「当时主库」的缺词
  assert.ok(neu.results[0].imported >= 4);
  // type6 也会从最终主库拿到 type5 的贡献
  assert.ok(neu.results[5].imported >= 5);
});
