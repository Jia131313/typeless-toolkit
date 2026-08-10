const fs = require('fs');
const net = require('net');

const DEFAULT_MANAGER_PORT = 7788;

function validPort(value, fallback = DEFAULT_MANAGER_PORT) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function readManagerPort(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8') || '{}');
    return validPort(config.manager_port);
  } catch (error) {
    return DEFAULT_MANAGER_PORT;
  }
}

function preferredManagerPort(configPath, environmentPort) {
  const configured = readManagerPort(configPath);
  if (environmentPort === undefined || environmentPort === null || environmentPort === '') return configured;
  return validPort(environmentPort, configured);
}

async function probeToolkit(port, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/env`, {
      signal: controller.signal,
      headers: { Host: `127.0.0.1:${port}` },
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body && body.status === 'OK' && body.data && body.data.service === 'typeless-toolkit';
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    server.unref();
    server.once('error', () => finish(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(error => finish(!error));
    });
  });
}

function fallbackPortCandidates(preferred) {
  const candidates = [];
  for (let offset = 1; offset <= 100 && preferred + offset <= 65535; offset++) {
    candidates.push(preferred + offset);
  }
  for (let port = 17888; port <= 17988; port++) candidates.push(port);
  return [...new Set(candidates)];
}

async function selectManagerEndpoint(preferredPort, dependencies = {}) {
  const preferred = validPort(preferredPort);
  const probe = dependencies.probeToolkit || probeToolkit;
  const bindable = dependencies.canListen || canListen;

  if (await probe(preferred)) {
    return { port: preferred, reuseExisting: true, reason: 'existing-toolkit' };
  }
  if (await bindable(preferred)) {
    return { port: preferred, reuseExisting: false, reason: 'preferred-available' };
  }
  for (const candidate of fallbackPortCandidates(preferred)) {
    if (await bindable(candidate)) {
      return { port: candidate, reuseExisting: false, reason: 'fallback' };
    }
  }
  throw new Error(`端口 ${preferred} 已被其他程序占用，且找不到可用的回退端口。请修改配置中的 manager_port。`);
}

module.exports = {
  DEFAULT_MANAGER_PORT,
  validPort,
  readManagerPort,
  preferredManagerPort,
  probeToolkit,
  canListen,
  fallbackPortCandidates,
  selectManagerEndpoint,
};
