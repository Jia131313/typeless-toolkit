# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-08-17
- Primary product surfaces: `manager.html` desktop management page, account detail modal, registration wizard, macOS permission guidance.
- Evidence reviewed: `README.md`, `AGENTS.md`, `manager.html`, `manager.js`, `lib/common.js`, existing light/dark CSS tokens, application icon assets, and the annotated macOS screenshot supplied on 2026-08-17.

## Brand
- Personality: practical, calm, direct, and trustworthy; this is a personal desktop utility, not a marketing site.
- Trust signals: show what will restart Typeless, what changes user data, current background status, recoverable errors, and the last successful operation.
- Avoid: hiding established direct-access actions, unexplained destructive wording, decorative duplication, and adding unrelated controls when a focused replacement is sufficient.

## Product goals
- Goals: make account switching and dictionary alignment feel automatic; keep new-account registration to one guided flow; preserve the original authors' direct, visible toolbar access for established maintenance actions.
- Non-goals: recreate Typeless settings, hide errors, infer destructive dictionary deletions from incomplete network responses, or add a new frontend framework.
- Success signals: a newly added account is aligned without another click; dictionary edits schedule alignment; the toolbar remains scannable at 1200 px and 880 px; users can see whether background alignment is healthy.

## Personas and jobs
- Primary personas: the repository contributors and technically comfortable Typeless users managing several personal accounts.
- User jobs: start Typeless, add or register an account, switch accounts, keep dictionaries aligned, inspect status, and recover from platform-specific problems.
- Key contexts of use: a desktop utility kept open beside Typeless, commonly in a dark macOS window, with intermittent API/network availability.

## Information architecture
- Primary navigation: a single dashboard; account cards open account details; modal surfaces handle registration, dictionary editing, status details, permissions, and shortcuts.
- Core routes/screens: dashboard, account detail, registration wizard, master dictionary, automatic dictionary status, advanced tools.
- Content hierarchy: preserve the existing two visible toolbar groups and every direct-access action; use compact labels and spacing to keep both groups on one line at the normal desktop width instead of reorganizing unrelated actions.

## Design principles
- Principle 1: automate safe, repeatable maintenance and keep a visible manual recovery path.
- Principle 2: one user intent should have one entry point; registration owns device reset and onboarding completion.
- Tradeoffs: automatic dictionary alignment is additive by default. Deletion propagates only from an explicit Toolkit delete or explicit master-list removal; absence in a remote fetch is not treated as deletion.

## Visual language
- Color: continue using the existing semantic CSS variables for background, cards, accent, success, warning, and error in both themes.
- Typography: retain the native system stack and existing compact desktop scale.
- Spacing/layout rhythm: 6 px toolbar control gaps, 8 px between toolbar groups, 12–20 px section spacing, and wrapping by semantic group only when the window is too narrow for the compact single row.
- Shape/radius/elevation: retain 9–14 px radii and subtle card elevation; status controls use pills rather than full primary buttons.
- Motion: short existing hover and theme transitions only; status updates must not pulse continuously.
- Imagery/iconography: reuse the application icon and simple text glyphs; icons supplement labels and never carry meaning alone.

## Components
- Existing components to reuse: `.btn`, `.badge`, `.status-pill`, `.modal`, `.hint`, `.tool-group`, toast, account cards, and current CSS variables.
- New/changed components: compact dictionary-sync status pill/button, streamlined registration wizard, background-sync status modal, and compact toolbar labels with full explanatory tooltips.
- Variants and states: dictionary status supports waiting, checking, aligned, partial, and error; advanced tools support platform-conditional items.
- Token/component ownership: `manager.html` remains the owner of the single-page component and token definitions; no parallel design-system layer.

## Accessibility
- Target standard: practical WCAG 2.1 AA behavior for this local desktop surface.
- Keyboard/focus behavior: interactive status and disclosure controls must be native buttons/details or keyboard-operable; Escape closes open modals.
- Contrast/readability: use semantic theme tokens and avoid low-contrast text on translucent surfaces.
- Screen-reader semantics: status text must be readable without color; background changes use `aria-live` where appropriate.
- Reduced motion and sensory considerations: no required animation; respect the current restrained transition style.

## Responsive behavior
- Supported breakpoints/devices: desktop windows around 1200 px default and 880 px narrow, with existing fallback below 720 px.
- Layout adaptations: keep all primary and system actions in one row at the normal 1200 px window; below the toolbar breakpoint, wrap the two semantic groups without hiding, collapsing, or horizontally scrolling any action.
- Touch/hover differences: all actions retain text labels and usable click targets; hover is enhancement only.

## Interaction states
- Loading: dictionary status says “正在检查” without blocking unrelated account actions.
- Empty: zero accounts is a valid waiting state and does not report an error.
- Error: retain the last successful timestamp, show failed account count, and allow “立即检查”.
- Success: show aligned account count, master term count, and last completion time without opening a modal automatically.
- Disabled: prevent duplicate manual sync while the single-flight background job is running.
- Offline/slow network, if applicable: background failures do not block the dashboard; the next periodic run retries automatically.

## Content voice
- Tone: concise, factual, and action-oriented.
- Terminology: use state-specific compact toolbar labels such as “词库已对齐”, retain “词库自动对齐” in the detailed modal, use “立即检查” for the manual fallback, and use compact “注册账号” in the toolbar while retaining “注册新账号” for the combined guided flow.
- Microcopy rules: explain consequences before restarts or deletions; do not ask users to perform a normal synchronization step after adding an account.
- Permission guidance: when a macOS Toolkit identity requires renewed App Management consent, explain the exact write operation, open the relevant System Settings pane, and resume the pending update or paywall repair when the user returns.

## Implementation constraints
- Framework/styling system: one dependency-free HTML/CSS/JavaScript page backed by Node.js HTTP routes.
- Design-token constraints: extend the existing variables and components; do not add a new CSS framework or dependency.
- Performance constraints: synchronization is single-flight, debounced, periodic at a modest interval, and must avoid high-frequency writes when the normalized master list is unchanged.
- Paywall maintenance constraints: startup and account/update workflows may trigger repair when the patch is missing; periodic checks defer while Typeless is active, and the visible action remains a status/retry surface.
- Compatibility constraints: Node.js 22.12+, Windows WebView2 host, macOS Electron host, and current local API security checks.
- Test/screenshot expectations: run `npm run check`, `git diff --check`, and inspect approximately 1200 px and 880 px layouts with no horizontal overflow or isolated controls.

## Open questions
- [ ] If Typeless later exposes a reliable server-side change log, revisit safe detection of deletions made directly inside Typeless; current ownership: maintainers; impact: automatic destructive propagation.

## Local layout demo — 2026-09-08

- Status: combined preview accepted for local installation (user: “这一遍还可以，实际给我装上看看”); not approved for release or upstream integration. This section overrides the earlier dashboard layout guidance for the current local UI trial.
- Request: “你再学习一下 ccswitch 的设计吧，前端这块别越改越难看了” → “你改个 demeo 我看看” → rejected: “我感觉你改远了，还不如现在的版本” → current request: “你结合一下，再给我个demo”. Borrow proportions without losing the original card structure and visual hierarchy; do not hide frequent actions.
- Reference: CC Switch official home/settings screenshots and source at `f3b18df12007d0fd79fd8ad8d310880664015197`. Borrow compact navigation, content-width controls and consistent spacing, not its provider-list structure or hover-only actions.
- Scope: restore the integrated baseline's blue theme tokens, original logo and account-card grouping; retain four settings categories, five home actions, all WebDAV fields and all account actions. Local build/install now authorized with existing external data preserved. No backend behavior changes, manual account operations, commit, push, PR, merge or Release.
- Implementation: replace the rejected full-width account rows with the original auto-fill grid (340px minimum columns); use compact overview cards, clear nickname/value weight and inset metadata groups. Snapshot and visible actions share each card's footer. Current account and maintenance state are accessible above the grid. Settings use compact segmented tabs and natural-height form/sidebar groups, without forced empty space for bottom alignment.
- Acceptance: inspect real rendered screenshots at 1200px and 880px, light/dark themes, two/six accounts, long names, cloud-only/invalid accounts and empty results. Account cards should remain roughly 230–280px tall, not fill unused columns or become wide table rows. No overflow, overlapping information or hidden switching action. Existing settings interactions and API payloads remain intact. Test success is not visual acceptance.
- Validation: this combined demo passed 16 Electron layout/interaction scenarios and 128 project tests; `git diff --check` passed. Inspected 1200/880px home, settings, and multi-account screenshots. Default cards measure about 373×257px at 1200px and 408×257px at 880px; no controls overflow or overlap. Temporary verification process/profile cleaned up. The prior long-row demo passed technical checks but was rejected visually and has been replaced, not kept as a second implementation. Preview continues to use in-memory fixtures only, without starting `manager.js` or connecting to real Typeless/WebDAV. Visual acceptance of this combined demo remains with the user.
- Local installation: completed using the existing arm64 macOS build/install scripts. Build ran 128 passing tests; strict code-signing verification passed. Installed archive and live HTTP homepage are byte-identical to the approved workspace UI, and the active service originates from the installed App. Confirmed account identities, account/config/dictionary file hashes and profile-content hashes unchanged across installation; Typeless's existing process stayed running. Actual native UI smoke check opened Home → Settings → Sync and data → Home successfully without changing settings. Installer temporary/previous App copies were removed. Toolkit App Management regrant is pending under the existing ad-hoc identity mechanism; no Typeless permission reset was manually invoked. The installed trial keeps package version 1.7.0; no commit, push, merge or public release was made. Awaiting user feedback from everyday use.

## Local review refinements — 1.7.1

- User feedback (2026-09-08): keep the approved design; use an ordinary arrow over the environment status; align the bottoms of the variable-height sync form and sidebar; show an upgrade icon when Toolkit or Typeless has an available update, opening the relevant update window on click. User will review again before approving publication.
- Version decision: this UI/interaction polish is 1.7.1, not 1.8.0. Future minor versions require a meaningful new capability (such as self-update or WebDAV); fixes and polish use patch versions.
- Plan: stretch the shared CSS grid row, keep the backup card naturally sized at the sidebar bottom, and let content determine total height; stack naturally below 720px. Replace the help cursor. Reuse the existing two update APIs/installation flows, aggregate their available states, and provide direct update dialogs without downloading/installing on inspection. Preserve all existing accounts, config, sync and maintenance behavior.
- Acceptance: 1200/880px light/dark; enabled/disabled/loading/error and long sync messages; bottom-edge difference <= 1px for two columns, natural single column; no overflow; no-update/Toolkit-only/Typeless-only/both/error/running states and Windows hiding; update icons open the right dialog and do not send install/download requests. Run project tests and isolated Electron preview checks, inspect actual screenshots. No push, merge, tag or Release before user approval.
- Implementation complete: the environment badge uses the default cursor. The sync grid stretches a content-sized row; the sidebar uses a flexible status card and naturally sized backup card, with no fixed height or resize script. The former duplicated home update status is replaced by one topbar upgrade button; the settings update tab shows the combined count. Single-source clicks open the matching window, two sources open a small target picker. Official checks run on startup, entering Updates and throttled window focus, and still consume only local caches. Toolkit checks preserve downloading/downloaded/installing stages; update dialogs distinguish loading and errors, and viewing does not install anything.
- Validation: 37 isolated Electron layout/interaction checks passed, including 18 enabled/disabled/long-message sync scenarios across 1200/880/680px and both themes. Measured two-column bottom-edge difference was 0px. Verified default cursor, update-source combinations, source removal/failure, direct dialogs, both choices, Windows hiding, and no download/install POST while viewing. Inspected rendered sync, home/update and official-dialog screenshots. Node UI tests include explicit install confirmation/permission/changed-package boundaries. Temporary Electron verification process/profile removed; no real data, permissions or installed apps were touched.
- Delivery: full npm run check passed (141 tests, 0 failures), and git diff --check passed. Local interactive preview rebuilt from the actual manager.html, with clearly labeled mock accounts and update availability. Project/package/Windows/doc versions aligned at 1.7.1; CHANGELOG remains unreleased and requires a real date only after approval. Local installed 1.7.0 remains unchanged this round. No commit, push, merge, tag or release; awaiting the user's final visual review.

## Release 1.7.1 — 2026-09-08

- User acceptance and authority: “没毛病，发吧”. The approved local UI is authorized for PR integration and v1.7.1 publication; existing user preference also requires updating the locally installed Toolkit while retaining its external data. Other contributors' open PRs are not included.
- Live baseline: local branch and origin/main both at e772db5 before this release; no upstream commits to reconcile. Release 1.7.0 is the latest published baseline; 1.7.1 does not yet exist.
- Plan and gates: finalize dated release notes and consistent versions; run project/UI verification and macOS package smoke checks; create a Chinese-titled PR and merge the exact validated head; tag v1.7.1 and use the existing Windows/macOS CI gates to publish all three packages and checksums. Verify actual Release content/assets and install the released Mac package locally, confirming version, API origin and preserved data. Keep demo outputs out of tracked/release files.
- Pre-publication verification: 142 Node tests and 37 isolated Electron scenarios passed. Release audit found and fixed quoted account names escaping their new title attributes, with a dedicated card-rendering regression. Rebuilt the final arm64 DMG; strict signature, sanitized archive, version and isolated packaged API smoke checks passed. Source is ready for PR integration and the existing two-platform release CI gates. Actual publication and local installation evidence will be recorded in the local release verification output; real data and other PRs remain untouched.
