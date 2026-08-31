# Refresh Token and Account Onboarding Design

## Context

Typeless Toolkit v1.6.0 assumes that the bearer token captured from a Typeless
API request is a roughly one-year credential. That assumption was compatible
with Typeless 2.0.1, but it is no longer true for newer clients. The observed
Typeless 2.4.0 authentication state contains:

- an `access` JWT with a 24-hour lifetime;
- a `refresh` JWT with a 365-day lifetime;
- client logic that refreshes the access token when fewer than ten minutes
  remain.

The same one-day behavior was reported against Typeless 2.3.1 in Issue #18.
Toolkit currently captures the first bearer request, stores only that access
token, rounds its remaining lifetime down to whole days, and therefore shows
`0 天` shortly after capture and `已过期` the next day.

## Goals

- Capture and persist the refresh token exposed by supported Typeless clients.
- Refresh short-lived access tokens just in time without requiring Toolkit to
  stay running.
- Keep existing accounts and older Typeless versions usable.
- Never expose either token from account-list or environment APIs.
- Show the effective login lifetime instead of the disposable access-token
  lifetime.
- Put account-collection actions together in the toolbar.
- Turn the current-account pill into the shortest path for collecting an
  unrecorded account.
- Ship public packages with an empty account list and useful first-run guidance.

## Non-goals

- Encrypting the local `accounts.json` file. It already stores bearer access
  tokens in plaintext, and local encryption is deferred until portable cloud
  synchronization is added.
- Keeping Toolkit alive to refresh tokens on a timer.
- Guessing, extending, or forging token expiration times.
- Automatically recovering an expired legacy account that has no refresh token
  and is not currently logged into Typeless.

## Credential Model

The existing `token` property remains the current access token so existing API
code and user data remain compatible. A captured account gains a
`refresh_token` property:

```json
{
  "user_id": "account-id",
  "nickname": "Local label",
  "email": "user@example.com",
  "role": "free",
  "token": "short-lived access JWT",
  "refresh_token": "long-lived refresh JWT",
  "captured_at": "2026-09-01T00:00:00.000Z",
  "added_at": "2026-09-01T00:00:00.000Z"
}
```

Expiration timestamps continue to be derived from signed JWT claims instead of
being duplicated in storage. Account-list serialization must remove both
`token` and `refresh_token` before sending data to the browser.

Legacy records with only `token` remain valid. They use the access-token expiry
for display and continue working until that token expires. Once expired, the UI
asks the user to switch to or log into that account and collect it again.

## Capturing Credentials

`captureTokenCDP` keeps its current lifecycle: temporarily restart Typeless with
a debug port when necessary, connect to a renderer, and restore the normal
launch mode in `finally`.

While connected, Toolkit first invokes Typeless's existing
`auth:get-current` IPC through the renderer preload bridge. A valid result must:

- contain access and refresh JWTs with `type=access` and `type=refresh`;
- contain the same account identity in both JWT subjects;
- match the current user ID returned by Typeless;
- have non-expired refresh credentials.

The network request listener remains as a compatibility fallback for Typeless
versions that do not expose `auth:get-current`. The fallback can collect an
access token but must not invent a refresh token.

No raw token or full authentication object is written to diagnostic logs.

## Just-in-time Refresh

A focused credential service owns access-token selection and refresh. Before an
account API operation:

1. Return the current access token when it has more than ten minutes remaining.
2. If it is expired or near expiry and a valid refresh token exists, call the
   same `/oauth/refresh_access_token` endpoint and platform app identifier used
   by Typeless.
3. Validate that the returned access JWT belongs to the same account and has
   `type=access`.
4. Persist the new access token atomically before returning it.
5. If the server also returns a replacement refresh token, validate and persist
   it in the same write so future token rotation is supported.

Concurrent requests for one account share a single refresh promise. Different
accounts may refresh independently, subject to the existing account-status
concurrency limit.

All account-backed operations must enter through this service, including live
status, dictionary reads and writes, automatic dictionary alignment, account
copy, and registration completion. No caller should cache an account object and
continue using its old token after refresh.

Toolkit does not need daily background activity. When it is closed, Typeless
uses its own encrypted authentication store and performs its own refresh. When
Toolkit opens again, it refreshes its local access-token cache on demand.

## Error Handling

Credential status distinguishes these cases:

- `valid`: the access token works or was refreshed successfully;
- `legacy`: only an access token exists and is still usable;
- `reauth_required`: the refresh token is absent, expired, rejected, or belongs
  to another account;
- `temporarily_unavailable`: refresh could not complete because of a network or
  server error.

A transient network failure must not be presented as permanent credential
expiry and must not delete stored tokens. Authentication rejection can mark the
account as requiring collection again. Error responses and logs must redact
Authorization headers and token response bodies.

## User Interface

- Move `添加当前账号` into the account-operation group immediately to the
  right of `注册账号`.
- Keep launch, refresh, dictionary status, master dictionary, backup, shortcuts,
  and platform maintenance controls in their existing operational groups.
- Clicking the current-account pill still performs a fresh local detection. If
  the detected account is not collected, open the add-account modal
  automatically. If it is already collected, only refresh the displayed state.
- Rename the account-card field from `凭证有效期` to `登录有效期`. Prefer the
  refresh-token expiry; fall back to the access-token expiry for legacy records.
- An empty account list explains that the user should log into Typeless and use
  `添加当前账号`, with a directly actionable button.

## Public and Local Builds

Public Lite and Portable packages create `data/accounts.json` containing `[]`.
They may retain a schema/example file for contributors, but no example account
is loaded into the product. The local self-update build continues preserving an
existing `data/accounts.json`; when it creates a new data directory, it also
starts with `[]`.

README and release-building assertions must describe and verify the empty
first-run state instead of a sanitized example account.

## Testing

Automated tests cover:

- parsing and validating access and refresh JWT roles and account identities;
- preferring IPC authentication over the first observed bearer request;
- falling back for older Typeless versions;
- no refresh when more than ten minutes remain;
- one refresh for concurrent account requests;
- persistence of refreshed access and rotated refresh tokens;
- legacy, expired refresh, authentication rejection, and transient-network
  states;
- redaction of both token fields from browser APIs;
- effective login-lifetime display;
- toolbar order, current-pill collection behavior, and first-run guidance;
- public-build creation and sanitization of an empty account list.

Platform verification includes Windows Typeless 2.4.0 and a macOS build using
the same IPC-first capture path. The Windows host, public release scripts, Node
test suite, narrow-window layout, and default-window layout are rechecked before
the PR is ready.

## Delivery

This is a blocking compatibility fix: current Typeless releases issue one-day
access tokens, so the existing account-management workflow becomes unusable
without it. The work is implemented and verified on `codex/refresh-token-auth`,
then fast-forwarded to and pushed directly on `main` under the repository's
maintainer exception for unambiguous maintenance fixes. After the push, Issue
#18 receives a concise root-cause explanation, affected-version evidence,
migration instructions for legacy accounts, and a link to the fix.
