const { localizedContext, sourcePage } = require('./helpers/i18n');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = sourcePage(fs.readFileSync(path.join(__dirname, '..', 'manager.html'), 'utf8'));
// 此连续代码段只包含额度 UI 函数，运行真实实现而不是复制逻辑。
const code = html.slice(html.indexOf('function renderQuotaMonitor('), html.indexOf('function openModal('));
function harness() {
  const elements = new Map(), posts = [], messages = [];
  const state = { state: 'low', config: { enabled: true, remaining: 200 }, current: { user_id: 'a' },
    candidate: { user_id: 'b', name: '<img src=x onerror=alert(1)>', remaining: 1900 }, alert_id: '1000-1', message: '剩余 100 字' };
  const context = vm.createContext(localizedContext({
    QUOTA_STATE: null, QUOTA_LOADED: false, QUOTA_LOADING: false, QUOTA_SWITCH_BUSY: false,
    // 自动切号引入的模块级变量(真实页面里声明在提取的代码段之外)
    QUOTA_ORDER: [], QUOTA_ORDER_VIEW: [], AUTO_COUNTDOWN_TIMER: null,
    document: {
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, { classList: { contains: () => false, add() {}, remove() {} } });
        }
        return elements.get(id);
      },
    },
    nfmt: String, confirm: () => false, toast: (...args) => messages.push(args), setTimeout: () => {},
    apiTimed: async () => ({ status: 'OK', data: state }),
    api: async (p, options) => { posts.push({ p, options }); return { status: 'OK' }; },
  }));
  vm.runInContext(code, context);
  context.renderQuotaMonitor(state);
  return { context, elements, posts, messages, state };
}

test('quota UI uses text nodes for account names and does not overwrite unsaved settings during polling', () => {
  const h = harness();
  assert.ok(h.elements.get('quotaNoticeDetail').textContent.includes(h.state.candidate.name));
  assert.equal(h.elements.get('quotaNoticeDetail').innerHTML, undefined);
  h.elements.get('quotaRemaining').value = '300'; h.context.renderQuotaMonitor(h.state);
  assert.equal(h.elements.get('quotaRemaining').value, '300');
  assert.equal(h.posts.length, 0);
});

test('cancelled recommendation never sends a switch request', async () => {
  const h = harness(); await h.context.switchQuotaCandidate(); assert.equal(h.posts.length, 0);
});

test('confirmed recommendation posts one guarded request despite repeated clicks', async () => {
  const h = harness(); let release;
  h.context.confirm = () => true;
  h.context.api = async (p, options) => { h.posts.push({ p, options }); return new Promise(resolve => { release = resolve; }); };
  const first = h.context.switchQuotaCandidate(); await h.context.switchQuotaCandidate();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].p, '/api/accounts/b/switch');
  assert.deepEqual(JSON.parse(h.posts[0].options.body), { quota_guard: { current_user_id: 'a', alert_id: '1000-1' } });
  release({ status: 'OK' }); await first; assert.equal(h.context.QUOTA_SWITCH_BUSY, false);
});

test('unreachable backend invalidates an old recommendation and blocks switching', async () => {
  const h = harness(); h.context.apiTimed = async () => { throw new Error('timeout'); };
  await h.context.refreshQuotaMonitor();
  assert.equal(h.context.QUOTA_STATE, null); assert.equal(h.elements.get('quotaSwitchBtn').hidden, true);
  h.context.confirm = () => true; await h.context.switchQuotaCandidate(); assert.equal(h.posts.length, 0);
});

test('disabled reminders hide the notice and cannot schedule checks from UI', () => {
  const h = harness(); h.context.renderQuotaMonitor({ ...h.state, config: { enabled: false, remaining: 200 }, state: 'disabled', candidate: null });
  assert.equal(h.elements.get('quotaNotice').hidden, true); assert.equal(h.elements.get('quotaSwitchBtn').hidden, true);
  assert.equal(h.elements.get('quotaCheckBtn').disabled, true);
});
