const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TYPELESS_EXE = '/path/that/does/not/exist';
const {
  effectiveCredentialExpiryMs,
  tokenType,
  tokenUserId,
  validateCapturedAuth,
} = require('../lib/common');

function jwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.fixture-signature`;
}

const NOW_SECONDS = 2_000_000_000;
const NOW_MS = NOW_SECONDS * 1000;

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

