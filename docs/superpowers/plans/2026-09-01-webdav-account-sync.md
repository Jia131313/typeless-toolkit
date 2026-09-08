# WebDAV Account Sync Implementation Plan

**Goal:** Add encrypted, conflict-safe account credential synchronization through generic WebDAV, with a Nutstore preset, as an independent feature PR.

**Architecture:** Keep local `accounts.json` behavior unchanged and add a separate encrypted remote vault. A provider-neutral sync service converts only portable account fields, merges records and deletion tombstones by `user_id`, and uses WebDAV ETags for optimistic concurrency. The manager exposes configuration/status APIs and a small settings dialog. Cloud-only accounts are activated locally through Typeless's supported auth IPC before snapshots can be switched.

**Tech stack:** Node.js CommonJS, built-in `crypto`, Fetch/WebDAV, `node:test`, vanilla HTML/CSS/JS.

---

### Task 1: Encrypted portable vault and deterministic merge

**Files:** `lib/account-sync.js`, `test/account-sync.test.js`

- Write failing tests for AES-256-GCM round trips, random salt/IV, wrong passwords, tampering, portable-field filtering, refresh-token identity validation, two-device additions, metadata updates, and deletion tombstones.
- Implement the versioned scrypt/AES-GCM envelope and merge helpers.
- Verify the focused test and commit.

### Task 2: WebDAV provider and conflict-safe synchronization

**Files:** `lib/account-sync.js`, `test/account-sync.test.js`

- Write failing tests using an in-process fake WebDAV server for URL validation, credential redaction, GET/PUT ETags, first creation, and bounded conflict retry.
- Implement generic WebDAV plus the Nutstore preset (`https://dav.jianguoyun.com/dav/`).
- Implement a single-flight read/merge/write service that preserves local access tokens and snapshots.
- Verify and commit.

### Task 3: Persist local account changes and expose manager APIs

**Files:** `lib/common.js`, `manager.js`, `test/manager-security.test.js`, `test/account-sync-manager.test.js`

- Add `updated_at` to account collection/refresh and persistent deletion tombstones.
- Add redacted config, connection-test, run, and status endpoints.
- Schedule configured sync after startup and local account mutations.
- Prove APIs never return WebDAV passwords, sync passwords, access tokens, or refresh tokens.
- Verify and commit.

### Task 4: Settings UI and cloud-only activation

**Files:** `manager.html`, `lib/common.js`, `manager.js`, `test/manager-ui.test.js`, `test/account-sync.test.js`

- Add an account-sync dialog with disabled/WebDAV/Nutstore choices, URL, username, application password, remote path, sync password, connection test, save, reconcile, and status.
- Mark pulled accounts without local snapshots as cloud-only and expose `在此设备启用`.
- Refresh the remote credential, invoke Typeless `auth:login` through the guarded CDP lifecycle, verify identity, apply onboarding, save a local snapshot, and always restore ordinary launch mode.
- Verify focused tests and commit.

### Task 5: Full verification and PR

- Run `npm.cmd run check` under Node 24.
- Build the Windows desktop host and both public packages.
- Run a local fake-WebDAV two-device integration test and inspect the complete diff.
- Push `codex/webdav-account-sync` and open a PR into `main`, documenting security, migration, verification, and deferred Google Drive/OneDrive providers.
