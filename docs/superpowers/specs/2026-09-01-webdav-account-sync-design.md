# WebDAV Account Sync Design

## Context and Dependency

Cross-device account portability depends on the refresh-token credential model
defined in `2026-09-01-refresh-token-account-onboarding-design.md`. The cloud
work begins only after that compatibility fix is verified and pushed to
`main`.

The first provider is generic WebDAV with a Nutstore preset. Google Drive and
OneDrive use provider-specific OAuth APIs rather than generic WebDAV, so they
are deferred behind the same provider interface.

## Goals

- Synchronize portable account identities and refresh credentials across
  Windows and macOS.
- Support standards-compliant WebDAV servers, with a one-click Nutstore URL
  preset and clear application-password guidance.
- Encrypt the remote vault without changing the existing plaintext local
  `accounts.json` behavior.
- Merge concurrent edits without silently losing accounts or resurrecting
  intentional deletions.
- Materialize a cloud-only account into a valid local Typeless login and local
  snapshot on first use.
- Keep cloud sync event-driven; Toolkit is not a daemon and need not stay open.

## Non-goals

- Synchronizing short-lived access tokens, device identifiers, Typeless program
  files, dictionaries, or raw profile snapshots.
- Implementing Google Drive or OneDrive in the first cloud-sync PR.
- Providing a hosted synchronization service operated by the maintainers.
- Hiding WebDAV credentials from an attacker who can already read the local
  plaintext account database. Remote-vault encryption protects data stored by
  the cloud provider and in transit between users' devices after download.

## Portable Account Schema

The decrypted remote payload is versioned and contains account records plus
deletion tombstones:

```json
{
  "version": 1,
  "updated_at": "2026-09-01T00:00:00.000Z",
  "accounts": [
    {
      "user_id": "account-id",
      "nickname": "Local label",
      "email": "user@example.com",
      "client_user_id": "client-user-id",
      "refresh_token": "long-lived refresh JWT",
      "updated_at": "2026-09-01T00:00:00.000Z",
      "deleted_at": null
    }
  ]
}
```

The remote format excludes `token`, `profiles/`, `user-data.json`, onboarding
files, device credentials, absolute paths, platform settings, and usage caches.

Local account writes update `updated_at`. When cloud sync is enabled, removing
an account creates a tombstone instead of immediately forgetting its identity.
Tombstones are retained long enough for every normal device to observe them and
are compacted only through an explicit future format migration, not by an
arbitrary short timer.

## Remote Encryption

Only the remote vault is encrypted. A user-chosen sync password is processed
with Node's built-in `crypto.scrypt` using a random salt and a fixed,
versioned cost profile. The derived 256-bit key encrypts the JSON payload with
AES-256-GCM, a fresh 96-bit IV, and authenticated version metadata.

The envelope contains only format version, KDF parameters, salt, IV,
ciphertext, and authentication tag. Wrong passwords and corrupted payloads fail
authentication before JSON parsing.

The vault is only a few kilobytes. Key derivation runs when synchronization is
configured or performed, and AES-GCM cost is negligible. It does not affect
dictation, account switching, or normal Typeless performance.

The user enters the same sync password once on each device. The local sync
configuration may remember it for convenience because the local account file is
already plaintext; it is never uploaded or logged.

## Provider Interface

Cloud-independent merge code depends on a small interface:

```text
readVault() -> { exists, content, revision }
writeVault(content, expectedRevision) -> { revision }
testConnection() -> provider metadata
```

The WebDAV implementation maps `revision` to ETag, reads with `GET`, creates the
Toolkit folder with `MKCOL`, and writes with conditional `PUT`. Existing files
use `If-Match`; first creation uses `If-None-Match: *` when supported.

WebDAV configuration contains provider label, HTTPS URL, username, application
password, and remote path. Nutstore pre-fills
`https://dav.jianguoyun.com/dav/` and a Toolkit-specific filename. Plain HTTP is
rejected except for loopback test servers. Secrets are redacted from all GET
configuration APIs, logs, and error messages.

Future Google Drive and OneDrive providers implement the same three operations
using their application-data APIs and OAuth revision identifiers.

## Merge and Conflict Handling

Synchronization is read-merge-write:

1. Read and decrypt the current remote vault, or create an empty version when it
   does not exist.
2. Convert local accounts and tombstones into portable records.
3. Merge by `user_id`. The newest valid `updated_at` wins ordinary metadata.
4. A newer `deleted_at` wins over an older active record.
5. For refresh credentials, accept only a JWT belonging to the same user. When
   two valid tokens differ, prefer the one with the later issue time, then the
   later expiry, then the record timestamp.
6. Apply the merged result locally while retaining local access tokens and
   snapshot state.
7. Encrypt and conditionally write the merged vault.

An ETag conflict causes a bounded re-read and merge retry. Three consecutive
conflicts stop with a clear retryable status rather than overwriting another
device. Network failures preserve both local data and the last known remote
revision.

## Sync Triggers and Status

Cloud synchronization runs:

- shortly after Toolkit startup when configured;
- after a local account is collected, renamed, refreshed with a rotated refresh
  token, or removed;
- when the user selects `立即同步`;
- on a modest retry interval while Toolkit remains open after a transient
  failure.

It does not run daily while Toolkit is closed. The next launch reconciles all
changes. A single-flight controller exposes idle, syncing, success, conflict,
authentication failure, decryption failure, and network failure states without
starting duplicate sync jobs.

## Materializing a Cloud-only Account

A pulled account may have no local Typeless snapshot. Its card remains visible
with an `在此设备启用` action instead of pretending it can already switch.

Activation performs this controlled sequence:

1. Validate the refresh token and obtain a fresh access token.
2. Temporarily start Typeless with CDP using the existing guarded lifecycle.
3. Invoke the supported `auth:login` IPC with the account identity, access token,
   refresh token, and current login timestamp.
4. Confirm that Typeless reports the expected current user.
5. Apply onboarding completion, save a machine-local snapshot, and restore the
   normal Typeless launch mode in `finally`.

If the installed Typeless version lacks the required IPC or rejects the remote
credential, activation fails without overwriting the current local snapshot and
asks the user to log in normally. Device-registration limits remain a separate
Typeless policy and are reported rather than bypassed.

After successful activation, Typeless owns its encrypted local login state and
refreshes independently even when Toolkit closes.

## User Interface

An account-sync settings dialog provides:

- disabled, generic WebDAV, and Nutstore choices;
- server URL, username, application password, remote path, and sync password;
- connection test, save, pull, push/reconcile, and status controls;
- explicit descriptions of what is and is not synchronized;
- warnings that losing the sync password makes the encrypted remote vault
  unrecoverable.

The normal account grid identifies cloud-only accounts and offers local
activation. It does not expose refresh-token values or WebDAV credentials.

## Testing

Automated tests use an in-process fake WebDAV server and cover:

- encrypted-vault round trips, random salts/IVs, wrong passwords, and tampering;
- URL validation and secret redaction;
- empty remote initialization and conditional creation;
- ETag reads, conditional writes, conflict retries, and bounded failure;
- two-device additions, edits, deletion tombstones, and deterministic merges;
- exclusion of access tokens, snapshots, device data, and local paths;
- refresh-token identity validation and replacement ordering;
- sync single-flight and trigger behavior;
- cloud-only account activation success, IPC absence, rejected refresh tokens,
  identity mismatch, timeout, and clean-launch restoration.

Manual verification uses two separate Toolkit data directories, then one
Windows and one macOS machine against a dedicated Nutstore test folder. Tests
confirm that Typeless continues working after Toolkit exits and that neither
device overwrites the other's independent local snapshots.

## Delivery

The WebDAV work is submitted as a second PR based on the merged refresh-token
foundation. Its provider boundary is documented so Google Drive and OneDrive
can be added later without changing vault encryption or merge semantics.
