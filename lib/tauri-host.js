const readline = require('readline');

function argumentValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

const runtimeOptions = Object.freeze({
  desktopHost: argumentValue('desktop-host') || '',
  dataDir: argumentValue('data-dir') || '',
  managerPort: argumentValue('manager-port') || '',
  edition: argumentValue('toolkit-edition') || '',
  arch: argumentValue('toolkit-arch') || '',
  hostPid: Number(argumentValue('host-pid') || 0) || 0,
  nodePath: argumentValue('node-path') || '',
  nodeSource: argumentValue('node-source') || '',
  nodeVersion: argumentValue('node-version') || process.version,
});

class TauriHostClient {
  constructor() {
    this.available = runtimeOptions.desktopHost === 'tauri';
    this.nextId = 1;
    this.pending = new Map();
    if (!this.available) return;

    // Tauri 托管模式约定 stdout 只承载 JSONL；业务日志全部写入 stderr。
    console.log = (...args) => console.error(...args);
    const input = readline.createInterface({ input: process.stdin });
    input.on('line', line => this.handleResponse(line));
    input.on('close', () => {
      this.rejectAll(new Error('Tauri 桌面宿主连接已关闭'));
      process.exit(0);
    });
  }

  handleResponse(line) {
    let message;
    try { message = JSON.parse(line); } catch (error) { return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result || {});
    else pending.reject(Object.assign(new Error(message.error?.message || message.error || '桌面宿主操作失败'), {
      code: message.error?.code || message.code || 'TAURI_HOST_ERROR',
      phase: message.error?.phase || message.phase || null,
    }));
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(method, params = {}) {
    if (!this.available) return Promise.reject(new Error('当前不是 Tauri 桌面宿主模式'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      process.stdout.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }
}

const tauriHost = new TauriHostClient();

module.exports = { runtimeOptions, tauriHost };
