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

## Implementation constraints
- Framework/styling system: one dependency-free HTML/CSS/JavaScript page backed by Node.js HTTP routes.
- Design-token constraints: extend the existing variables and components; do not add a new CSS framework or dependency.
- Performance constraints: synchronization is single-flight, debounced, periodic at a modest interval, and must avoid high-frequency writes when the normalized master list is unchanged.
- Compatibility constraints: Node.js 22.12+, Windows WebView2 host, macOS Electron host, and current local API security checks.
- Test/screenshot expectations: run `npm run check`, `git diff --check`, and inspect approximately 1200 px and 880 px layouts with no horizontal overflow or isolated controls.

## Open questions
- [ ] If Typeless later exposes a reliable server-side change log, revisit safe detection of deletions made directly inside Typeless; current ownership: maintainers; impact: automatic destructive propagation.
