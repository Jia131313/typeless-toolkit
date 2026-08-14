'use strict';
/**
 * CDP 调试端口避让(issue #12):配置端口被占用时自动跳到空闲端口,
 * 并返回实际使用的端口供 CDP 流程继续。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { portOccupied, findFreePort } = require('../lib/platform');

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

describe('CDP port avoidance', () => {
  it('portOccupied detects an occupied TCP port', async () => {
    const server = await listen(0);
    const port = server.address().port;
    try {
      assert.equal(await portOccupied(port), true);
      assert.equal(await portOccupied(port + 50000), false);
    } finally {
      server.close();
    }
  });

  it('findFreePort skips occupied ports and returns a free one', async () => {
    const server = await listen(0);
    const port = server.address().port;
    try {
      const free = await findFreePort(port, 1, 20);
      assert.notEqual(free, port);
      assert.equal(await portOccupied(free), false);
    } finally {
      server.close();
    }
  });

  it('findFreePort returns the preferred port when it is free', async () => {
    // 9222 大概率空闲;若被占用则跳过该测试(CI 环境),避免偶发失败
    if (await portOccupied(9222)) return;
    const free = await findFreePort(9222);
    assert.equal(free, 9222);
  });
});
