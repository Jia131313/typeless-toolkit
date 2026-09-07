const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TYPELESS_EXE = '/path/that/does/not/exist';
const {
  buildTypelessLoginAuth,
  createAccountActivator,
  createAccountCredentialManager,
  createLiveStatus,
  createTypelessRefreshRequest,
  effectiveCredentialExpiryMs,
  selectCapturedAuth,
  tokenExpiryMs,
  tokenType,
  tokenUserId,
  validateCapturedAuth,
} = require('../lib/common');
const { platform } = require('../lib/platform');

function jwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.fixture-signature`;
}

const NOW_SECONDS = 2_000_000_000;
const NOW_MS = NOW_SECONDS * 1000;

test('uses the auth app identifier required by Typeless 2.4', () => {
  assert.equal(platform.authAppName(), 'typeless_webapp');
});

test('sends the OAuth app as the POST body used by the Typeless client', async () => {
  let args;
  const request = createTypelessRefreshRequest(async (...received) => {
    args = received;
    return { data: { access_token: 'fresh-token' } };
  });
  assert.deepEqual(await request('refresh-token', 'typeless_webapp'), { access_token: 'fresh-token' });
  assert.deepEqual(args, [
    'POST',
    '/oauth/refresh_access_token',
    'refresh-token',
    { app: 'typeless_webapp' },
  ]);
});

function accessToken(userId = 'user-1', expiresIn = 86400) {
  return jwt({
    type: 'access',
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + expiresIn,
    subject: { user_id: userId },
  });
}

function refreshToken(userId = 'user-1', expiresIn = 31536000) {
  return jwt({
    type: 'refresh',
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + expiresIn,
    subject: { user_id: userId },
  });
}

test('reads JWT credential roles and account identities', () => {
  assert.equal(tokenType(accessToken()), 'access');
  assert.equal(tokenType(refreshToken()), 'refresh');
  assert.equal(tokenUserId(accessToken()), 'user-1');
  assert.equal(tokenType('not-a-jwt'), null);
  assert.equal(tokenUserId('not-a-jwt'), null);
});

test('accepts a matching access and refresh credential pair', () => {
  const access = accessToken();
  const refresh = refreshToken();

  assert.deepEqual(validateCapturedAuth({
    user_id: 'user-1',
    client_user_id: 'client-1',
    access_token: access,
    refresh_token: refresh,
  }, NOW_MS), {
    user_id: 'user-1',
    client_user_id: 'client-1',
    token: access,
    refresh_token: refresh,
  });
  assert.equal(
    effectiveCredentialExpiryMs({ token: access, refresh_token: refresh }),
    (NOW_SECONDS + 31536000) * 1000,
  );
});

test('rejects incorrect roles, identities, and expired refresh credentials', () => {
  assert.throws(() => validateCapturedAuth({
    user_id: 'user-1',
    access_token: refreshToken(),
    refresh_token: accessToken(),
  }, NOW_MS), /access token/i);

  assert.throws(() => validateCapturedAuth({
    user_id: 'user-1',
    access_token: accessToken('user-1'),
    refresh_token: refreshToken('user-2'),
  }, NOW_MS), /账号不一致/);

  assert.throws(() => validateCapturedAuth({
    user_id: 'user-1',
    access_token: accessToken(),
    refresh_token: refreshToken('user-1', -1),
  }, NOW_MS), /refresh token 已过期/i);
});

test('keeps access-only captures compatible with old Typeless versions', () => {
  const access = accessToken();
  assert.deepEqual(validateCapturedAuth({
    user_id: 'user-1',
    access_token: access,
  }, NOW_MS), {
    user_id: 'user-1',
    client_user_id: null,
    token: access,
    refresh_token: null,
  });
  assert.equal(effectiveCredentialExpiryMs({ token: access }), (NOW_SECONDS + 86400) * 1000);
});

test('prefers the IPC credential pair over captured network bearers', () => {
  const ipcAccess = accessToken('user-1');
  const ipcRefresh = refreshToken('user-1');
  const networkAccess = accessToken('user-2');
  const selected = selectCapturedAuth({
    user_id: 'user-1',
    client_user_id: 'client-1',
    access_token: ipcAccess,
    refresh_token: ipcRefresh,
  }, [{ url: 'https://api.example.test/path', auth: `Bearer ${networkAccess}` }], {
    found: true,
    user_id: 'user-1',
    email: 'one@example.test',
    roles: 'free',
  }, NOW_MS);

  assert.equal(selected.token, ipcAccess);
  assert.equal(selected.refresh_token, ipcRefresh);
  assert.equal(selected.origin, 'https://api.typeless.com');
  assert.equal(selected.user_info.email, 'one@example.test');
});

test('falls back to access network bearers and ignores refresh bearers', () => {
  const access = accessToken('user-1');
  const selected = selectCapturedAuth(null, [
    { url: 'https://api.example.test/refresh', auth: `Bearer ${refreshToken('user-1')}` },
    { url: 'https://api.example.test/user', auth: `Bearer ${access}` },
  ], { found: true, user_id: 'user-1', email: '', roles: '' }, NOW_MS);

  assert.equal(selected.token, access);
  assert.equal(selected.refresh_token, null);
  assert.equal(selected.origin, 'https://api.example.test');
});

test('rejects captured credentials that do not match the current account', () => {
  assert.throws(() => selectCapturedAuth({
    user_id: 'user-2',
    access_token: accessToken('user-2'),
    refresh_token: refreshToken('user-2'),
  }, [], { found: true, user_id: 'user-1' }, NOW_MS), /账号不一致/);
});

test('refreshes a nearly expired access token and persists rotated credentials', async () => {
  const oldRefresh = refreshToken('user-1');
  const freshAccess = accessToken('user-1', 7200);
  const freshRefresh = refreshToken('user-1', 31536000 + 60);
  let accounts = [{ user_id: 'user-1', token: accessToken('user-1', 300), refresh_token: oldRefresh }];
  let requestArgs;
  const manager = createAccountCredentialManager({
    readAccountsFn: () => accounts,
    writeAccountsFn: next => { accounts = next; },
    refreshRequestFn: async (...args) => {
      requestArgs = args;
      return { access_token: freshAccess, refresh_token: freshRefresh };
    },
    nowFn: () => NOW_MS,
    appName: 'typeless_webapp',
  });

  assert.equal(await manager.ensureAccessToken(accounts[0]), freshAccess);
  assert.deepEqual(requestArgs, [oldRefresh, 'typeless_webapp']);
  assert.equal(accounts[0].token, freshAccess);
  assert.equal(accounts[0].refresh_token, freshRefresh);
});

test('keeps valid access tokens and coalesces concurrent refreshes', async () => {
  const valid = { user_id: 'user-1', token: accessToken('user-1', 3600), refresh_token: refreshToken('user-1') };
  let calls = 0;
  const noRefresh = createAccountCredentialManager({
    readAccountsFn: () => [valid], writeAccountsFn: () => {},
    refreshRequestFn: async () => { calls++; }, nowFn: () => NOW_MS, appName: 'typeless_webapp',
  });
  assert.equal(await noRefresh.ensureAccessToken(valid), valid.token);
  assert.equal(calls, 0);

  const expiring = { user_id: 'user-1', token: accessToken('user-1', 1), refresh_token: refreshToken('user-1') };
  const fresh = accessToken('user-1', 3600);
  const singleFlight = createAccountCredentialManager({
    readAccountsFn: () => [expiring], writeAccountsFn: () => {},
    refreshRequestFn: async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return { access_token: fresh }; },
    nowFn: () => NOW_MS, appName: 'typeless_webapp',
  });
  assert.deepEqual(await Promise.all([
    singleFlight.ensureAccessToken(expiring),
    singleFlight.ensureAccessToken(expiring),
  ]), [fresh, fresh]);
  assert.equal(calls, 1);
});

test('background credential refresh keeps the account sync event time and concurrent edits', async () => {
  const capturedAt = new Date(NOW_MS - 86400000).toISOString();
  const original = { user_id: 'user-1', nickname: 'before', captured_at: capturedAt,
    token: accessToken('user-1', 1), refresh_token: refreshToken() };
  let accounts = [original];
  const manager = createAccountCredentialManager({
    readAccountsFn: () => accounts,
    writeAccountsFn: next => { accounts = next; },
    refreshRequestFn: async () => {
      accounts = [{ ...original, nickname: 'edited during refresh' }];
      return { access_token: accessToken('user-1', 3600) };
    },
    nowFn: () => NOW_MS, appName: 'typeless_webapp',
  });
  await manager.ensureAccessToken(original);
  assert.equal(accounts[0].updated_at, capturedAt);
  assert.equal(accounts[0].nickname, 'edited during refresh');
});

test('a pending credential refresh cannot recreate a deleted account', async () => {
  const original = { user_id: 'user-1', token: accessToken('user-1', 1), refresh_token: refreshToken() };
  let accounts = [original];
  const manager = createAccountCredentialManager({
    readAccountsFn: () => accounts,
    writeAccountsFn: next => { accounts = next; },
    refreshRequestFn: async () => {
      accounts = [];
      return { access_token: accessToken('user-1', 3600) };
    },
    nowFn: () => NOW_MS, appName: 'typeless_webapp',
  });
  await assert.rejects(manager.ensureAccessToken(original), /已.*删除/);
  assert.deepEqual(accounts, []);
});

test('rejects unusable refresh responses without deleting stored credentials', async () => {
  const original = { user_id: 'user-1', token: accessToken('user-1', -1), refresh_token: refreshToken('user-1') };
  const accounts = [original];
  const mismatch = createAccountCredentialManager({
    readAccountsFn: () => accounts, writeAccountsFn: () => assert.fail('must not persist invalid credentials'),
    refreshRequestFn: async () => ({ access_token: accessToken('user-2') }),
    nowFn: () => NOW_MS, appName: 'typeless_webapp',
  });
  await assert.rejects(mismatch.ensureAccessToken(original), /账号不一致/);
  assert.equal(accounts[0].refresh_token, original.refresh_token);

  const transient = createAccountCredentialManager({
    readAccountsFn: () => accounts, writeAccountsFn: () => assert.fail('must not delete credentials'),
    refreshRequestFn: async () => { throw new Error('network unavailable'); },
    nowFn: () => NOW_MS, appName: 'typeless_webapp',
  });
  await assert.rejects(transient.ensureAccessToken(original), /network unavailable/);

  const expiredRefreshAccount = {
    user_id: 'user-1', token: accessToken('user-1', -1), refresh_token: refreshToken('user-1', -1),
  };
  await assert.rejects(transient.ensureAccessToken(expiredRefreshAccount), /refresh token 已过期/i);
});

test('live status refreshes credentials before every account API request', async () => {
  const old = accessToken('user-1', -1);
  const fresh = accessToken('user-1', 3600);
  const refresh = refreshToken('user-1');
  const account = { user_id: 'user-1', token: old, refresh_token: refresh };
  let ensured = false;
  const seenTokens = [];
  const status = createLiveStatus({
    nowFn: () => NOW_MS,
    ensureAccessTokenFn: async target => {
      ensured = true;
      target.token = fresh;
      return fresh;
    },
    curlApiFn: async (method, path, token) => {
      assert.equal(ensured, true);
      seenTokens.push(token);
      if (path === '/user/get_user_info') return { data: { id: 'user-1' } };
      if (path === '/user/usage_stats') return { data: { voice_transcription: { used: 0 } } };
      if (path === '/user/personal_stats') return { data: {} };
      return { data: { total_count: 0 } };
    },
  });

  const result = await status(account);
  assert.equal(result.token_valid, true);
  assert.equal(result.credential_state, 'ready');
  assert.equal(result.access_exp, tokenExpiryMs(fresh));
  assert.equal(result.credential_exp, tokenExpiryMs(refresh));
  assert.deepEqual(seenTokens, [fresh, fresh, fresh, fresh]);
});

test('live status distinguishes refresh failures from permanent expiry', async () => {
  const makeStatus = message => createLiveStatus({
    nowFn: () => NOW_MS,
    ensureAccessTokenFn: async () => { throw new Error(message); },
    curlApiFn: async () => assert.fail('API must not run without a usable access token'),
  })({ user_id: 'user-1', token: accessToken('user-1', -1), refresh_token: refreshToken('user-1') });

  assert.equal((await makeStatus('network unavailable')).credential_state, 'refresh_error');
  assert.equal((await makeStatus('refresh token 已过期')).credential_state, 'expired');
});

test('builds a Typeless auth:login payload from a matching refresh credential', () => {
  const access = accessToken('user-1', 3600);
  const refresh = refreshToken('user-1');
  assert.deepEqual(buildTypelessLoginAuth({
    user_id: 'user-1', email: 'one@example.test', client_user_id: 'client-1', refresh_token: refresh,
  }, access, NOW_MS), {
    user_id: 'user-1',
    email: 'one@example.test',
    client_user_id: 'client-1',
    access_token: access,
    refresh_token: refresh,
    login_time: NOW_MS,
  });
  assert.throws(() => buildTypelessLoginAuth({
    user_id: 'user-2', refresh_token: refreshToken('user-2'),
  }, access, NOW_MS), /账号不一致/);
});

test('activates a cloud account through auth:login and creates its local snapshot', async () => {
  const access = accessToken('user-1', 3600);
  const refresh = refreshToken('user-1');
  let accounts = [{ user_id: 'user-1', email: 'one@example.test', refresh_token: refresh, cloud_only: true }];
  const events = [];
  const activate = createAccountActivator({
    ensureAccessTokenFn: async () => access,
    portUpFn: async () => false,
    isAppRunningFn: async () => false,
    restartWithDebugFn: async () => { events.push('debug'); return 9333; },
    restartCleanFn: async (_exe, shouldRun) => { events.push(`clean:${shouldRun}`); },
    withCDPFn: async (callback, port) => {
      assert.equal(port, 9333);
      return callback(null, async expression => {
        assert.match(expression, /auth:login/);
        return JSON.stringify({ current: { user_id: 'user-1' } });
      });
    },
    preserveCurrentFn: () => events.push('preserve'),
    applyOnboardingFn: () => events.push('onboarding'),
    saveSnapshotFn: userId => events.push(`snapshot:${userId}`),
    readAccountsFn: () => accounts,
    writeAccountsFn: next => { accounts = next; },
    nowFn: () => NOW_MS,
    settleFn: async () => {},
    typelessExe: 'Typeless.exe',
    userDataDir: 'userdata',
  });

  const result = await activate(accounts[0]);
  assert.equal(result.account.cloud_only, false);
  assert.equal(result.account.token, access);
  assert.deepEqual(events, ['preserve', 'debug', 'onboarding', 'snapshot:user-1', 'clean:true']);
});
