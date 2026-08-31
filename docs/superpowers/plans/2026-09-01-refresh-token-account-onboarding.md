# Refresh Token and Account Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore long-lived Typeless account management by capturing refresh tokens, refreshing one-day access tokens on demand, and removing first-run account-collection friction.

**Architecture:** Add pure JWT/auth validation helpers and an injected, single-flight credential manager in `lib/common.js`; make CDP capture prefer Typeless's `auth:get-current` IPC; route every account API operation through refreshed account credentials. Keep local storage backward compatible (`token` remains the access token, `refresh_token` is additive), then update the existing single-page UI and release scripts.

**Tech Stack:** Node.js 24 CommonJS, built-in `node:test`, CDP over `ws`, existing curl-based Typeless API client, vanilla HTML/CSS/JavaScript, PowerShell and batch release scripts.

---

### Task 1: JWT role and captured-auth validation

**Files:**
- Create: `test/auth-credentials.test.js`
- Modify: `lib/common.js`

- [ ] **Step 1: Write failing pure-helper tests**

Create signed-shape fixture JWTs with base64url headers/payloads and a placeholder signature. Assert that `tokenType`, `tokenUserId`, `validateCapturedAuth`, and `effectiveCredentialExpiryMs`:

```js
const access = jwt({ type: 'access', iat: now, exp: now + 86400, subject: { user_id: 'u1' } });
const refresh = jwt({ type: 'refresh', iat: now, exp: now + 31536000, subject: { user_id: 'u1' } });
assert.equal(tokenType(access), 'access');
assert.equal(tokenUserId(refresh), 'u1');
assert.deepEqual(validateCapturedAuth({ user_id: 'u1', access_token: access, refresh_token: refresh }, now * 1000), {
  user_id: 'u1', token: access, refresh_token: refresh,
});
assert.equal(effectiveCredentialExpiryMs({ token: access, refresh_token: refresh }), (now + 31536000) * 1000);
```

Also assert rejection of swapped token roles, mismatched subjects, and expired refresh tokens, plus access-only legacy fallback.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/auth-credentials.test.js
```

Expected: FAIL because the helper exports do not exist.

- [ ] **Step 3: Implement the minimal pure helpers**

Add helpers next to `parseJwt`:

```js
function tokenType(token) { return parseJwt(token)?.type || null; }
function tokenUserId(token) { return parseJwt(token)?.subject?.user_id || null; }
function effectiveCredentialExpiryMs(account) {
  return tokenExpiryMs(account?.refresh_token) || tokenExpiryMs(account?.token);
}
function validateCapturedAuth(auth, nowMs = Date.now()) {
  // Validate role, subject equality, requested user identity, and refresh expiry.
}
```

Export the helpers and keep error messages free of raw token values.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run `node --test test/auth-credentials.test.js` and expect all new tests to pass.

- [ ] **Step 5: Commit**

```powershell
git add test/auth-credentials.test.js lib/common.js
git commit -m "test: define long-lived credential validation"
```

### Task 2: IPC-first CDP credential capture

**Files:**
- Modify: `test/auth-credentials.test.js`
- Modify: `lib/common.js`

- [ ] **Step 1: Write failing selection tests**

Define a pure `selectCapturedAuth(ipcAuth, bearerCandidates, currentInfo, nowMs)` API. Test that it prefers a valid IPC access/refresh pair over the first network bearer, falls back to a valid access bearer for old clients, ignores refresh bearers in the fallback list, and rejects account mismatches.

- [ ] **Step 2: Run the focused test and verify RED**

Run `node --test test/auth-credentials.test.js`; expect failure because `selectCapturedAuth` is missing.

- [ ] **Step 3: Implement selection and wire it into capture**

Inside the existing `withCDP` callback, evaluate:

```js
const authJson = await ev(`(async()=>JSON.stringify(await window.ipcRenderer.invoke('auth:get-current')))()`);
```

Parse it defensively, keep the network listener active as fallback, and pass both sources through `selectCapturedAuth`. Return:

```js
{
  token,
  refresh_token,
  origin,
  user_id,
  user_info,
  client_user_id,
  captured_at,
}
```

Do not log auth JSON or token strings. Preserve debug-start and clean-restart behavior in `finally`.

- [ ] **Step 4: Run focused and lifecycle tests**

Run:

```powershell
node --test test/auth-credentials.test.js test/manager-security.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add test/auth-credentials.test.js lib/common.js
git commit -m "fix: capture Typeless refresh credentials"
```

### Task 3: Single-flight just-in-time access refresh

**Files:**
- Modify: `test/auth-credentials.test.js`
- Modify: `lib/common.js`
- Modify: `lib/platform.js`

- [ ] **Step 1: Write failing credential-manager tests**

Specify `createAccountCredentialManager({ readAccountsFn, writeAccountsFn, refreshRequestFn, nowFn, appName })` with tests for:

```js
const manager = createAccountCredentialManager({
  readAccountsFn: () => accounts,
  writeAccountsFn: next => { accounts = next; },
  refreshRequestFn: async refreshToken => ({ access_token: freshAccess }),
  nowFn: () => nowMs,
  appName: 'typeless_webapp',
});
assert.equal(await manager.ensureAccessToken(accounts[0]), freshAccess);
assert.equal(accounts[0].token, freshAccess);
```

Cover no refresh with more than ten minutes left, one refresh for concurrent calls, rotated refresh-token persistence, subject mismatch, missing/expired refresh, and transient request failure without deletion.

- [ ] **Step 2: Run focused test and verify RED**

Run `node --test test/auth-credentials.test.js`; expect missing-manager failure.

- [ ] **Step 3: Add platform app identifiers**

Expose `authAppName()` from each platform implementation:

```js
// Typeless 2.4 uses the same OAuth client identifier on both desktop platforms.
authAppName() { return 'typeless_webapp'; }
```

- [ ] **Step 4: Implement the credential manager**

Use a `Map<user_id, Promise>` for single-flight refreshes. The production refresh request calls:

```js
curlApi('POST', '/oauth/refresh_access_token', refreshToken, { app: PLAT.authAppName() })
```

Accept `response.data.access_token`; validate access and optional replacement refresh tokens; update both the passed account object and the matching persisted account record. Export `ensureAccountAccessToken` and a small `ensureAccountCredentials` wrapper for callers that need the updated object.

- [ ] **Step 5: Run focused test and verify GREEN**

Run `node --test test/auth-credentials.test.js`; expect PASS.

- [ ] **Step 6: Commit**

```powershell
git add test/auth-credentials.test.js lib/common.js lib/platform.js
git commit -m "fix: refresh short-lived access tokens on demand"
```

### Task 4: Route every account API operation through fresh credentials

**Files:**
- Modify: `test/auth-credentials.test.js`
- Modify: `lib/common.js`
- Modify: `manager.js`
- Modify: `typeless-dict-sync.js` if direct account tokens remain

- [ ] **Step 1: Add failing live-status behavior tests**

Use the injected credential manager or exported helper boundary to prove that an expired access token with a valid refresh token is refreshed before status requests and that transient refresh failure is reported separately from permanent expiry.

- [ ] **Step 2: Run focused tests and verify RED**

Run `node --test test/auth-credentials.test.js`; expect the status-path assertion to fail.

- [ ] **Step 3: Integrate refresh at account boundaries**

Update `liveStatus`, `syncAccount`, `syncAllAccounts`, master push/import, delete, copy, dictionary routes, and any other result from:

```powershell
rg -n "\b(?:acc|src|dst)\.token\b" lib/common.js manager.js typeless-dict-sync.js
```

Every match must either follow `await ensureAccountAccessToken(account)` in the same operation or receive a freshly returned token. `liveStatus` exposes access expiry, refresh expiry, effective expiry, effective days left, and a credential-state string.

- [ ] **Step 4: Persist refresh tokens from add and register flows**

Extend account records created by `/api/accounts` and the registration wizard with `refresh_token` and `client_user_id`. Preserve an existing refresh token when an old-client fallback capture updates only the access token.

- [ ] **Step 5: Strengthen API redaction**

Update `accountForClient` to strip both credentials:

```js
const { token, refresh_token, ...safe } = account || {};
```

Extend `test/manager-security.test.js` so a fixture containing both secrets proves neither is returned.

- [ ] **Step 6: Run focused tests and audit direct token uses**

Run:

```powershell
node --test test/auth-credentials.test.js test/manager-security.test.js test/dictionary-sync.test.js
rg -n "\b(?:acc|src|dst)\.token\b" lib/common.js manager.js typeless-dict-sync.js
```

Expected: tests pass; remaining direct uses are each immediately dominated by credential refresh or are explicitly token-only utilities.

- [ ] **Step 7: Commit**

```powershell
git add test/auth-credentials.test.js test/manager-security.test.js lib/common.js manager.js typeless-dict-sync.js
git commit -m "fix: use refreshed credentials for account APIs"
```

### Task 5: Account collection and effective-lifetime UI

**Files:**
- Create: `test/manager-ui.test.js`
- Modify: `manager.html`

- [ ] **Step 1: Write failing static UI tests**

Read `manager.html` and assert:

- `注册账号` occurs before `添加当前账号` in the system/account action group;
- the old primary-group add button is absent;
- the label is `添加当前账号`;
- uncollected current-account handling calls `addAccount()` after detection;
- account cards use `登录有效期` and `credential_days_left`;
- the empty state includes a direct collection action.

- [ ] **Step 2: Run UI tests and verify RED**

Run `node --test test/manager-ui.test.js`; expect ordering and behavior failures.

- [ ] **Step 3: Implement the toolbar and current-pill behavior**

Move the add button directly after registration. In `detectCurrent(manual)`, after a successful detection and account lookup, call `addAccount()` only when `manual === true` and the account is uncollected. Preserve the normal 20-second passive polling behavior.

- [ ] **Step 4: Implement lifetime and first-run copy**

Render effective credential days and state supplied by the backend. Replace the example-account-oriented empty state with an explanation and button that opens the add modal.

- [ ] **Step 5: Run UI and inline-script syntax tests**

Run:

```powershell
node --test test/manager-ui.test.js test/manager-security.test.js
```

Expected: PASS, including the existing `vm.Script` compilation check.

- [ ] **Step 6: Commit**

```powershell
git add test/manager-ui.test.js manager.html
git commit -m "fix: streamline current-account collection"
```

### Task 6: Remove the shipped example account

**Files:**
- Create: `test/release-data.test.js`
- Modify: `build-public-release.ps1`
- Modify: `build-release.bat`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write failing release-script tests**

Assert that public builds write `[]` to `data/accounts.json`, local builds initialize a missing account file to `[]`, and public sanitization requires zero accounts. Keep `accounts.example.json` only as a contributor reference if desired.

- [ ] **Step 2: Run focused test and verify RED**

Run `node --test test/release-data.test.js`; expect failures on the current example-copy behavior.

- [ ] **Step 3: Update build scripts and documentation**

Use PowerShell `[IO.File]::WriteAllText(..., '[]', UTF8Encoding(false))` for public data and a batch-safe `echo []>` initialization for a missing local file. Change public assertions to require an empty array. Update README and AGENTS statements from “示例账号” to “空账号列表”.

- [ ] **Step 4: Run focused tests and diff checks**

Run:

```powershell
node --test test/release-data.test.js
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add test/release-data.test.js build-public-release.ps1 build-release.bat README.md AGENTS.md
git commit -m "fix: start releases with an empty account list"
```

### Task 7: Real-client verification, integration, and Issue #18

**Files:**
- Modify as required by defects found during verification

- [ ] **Step 1: Run the full Node verification under Node 24**

```powershell
$env:Path='C:\Users\T3231\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;'+$env:Path
npm.cmd run check
```

Expected: all applicable tests pass with zero failures.

- [ ] **Step 2: Verify the Windows host and public packages**

```powershell
cmd.exe /c build-tray.bat
cmd.exe /c build-public-release.bat
```

Expected: Windows host compiles; Lite and Portable archives build; public-data assertions confirm zero accounts and empty profiles.

- [ ] **Step 3: Exercise Typeless 2.4.0 locally**

Use the source manager on a non-conflicting port or a temporary data directory. Collect the current account, verify that the stored access JWT is 24 hours and refresh JWT is 365 days without printing either token, force the access-expiry path in a disposable data copy, and confirm refresh plus API status succeeds. Confirm Typeless returns to normal launch mode.

- [ ] **Step 4: Inspect the complete diff and run fresh verification**

Run `git diff origin/main...HEAD`, `git diff --check`, and `npm.cmd run check` again after any manual-verification fixes.

- [ ] **Step 5: Commit final verification fixes**

Commit only if Step 3 or 4 required code changes; otherwise leave the verified commits unchanged.

- [ ] **Step 6: Integrate the approved maintenance fix**

The user has already selected direct integration. Update local `main` with `git pull --ff-only origin main`, fast-forward it to `codex/refresh-token-auth`, rerun `npm.cmd run check` on `main`, and push `main` to `origin` without force.

- [ ] **Step 7: Reply to Issue #18**

Post the verified root cause, affected Typeless version range, fixed behavior, and one-time migration instruction. Do not include token values, local paths, or account identities.
