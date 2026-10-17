# HH.H Design System: Technical Specification

**Status:** Draft; not implemented

**Version:** 1.0-draft (first version)

**Date:** October 17, 2026

**Component:** two public packages published to npm, `packages/hhh-css` (`@hhh/css`: tokens, component CSS, original icons, medals and emblems) and `packages/hhh-react` (`@hhh/react`: React components); two private workspaces, `packages/art` (`@mcc/art`: logo, generated art and its manifest) and `packages/storybook` (`@mcc/storybook`: the shared Storybook); mockup stories and domain components in `applications/admin` and `applications/player`; the `scripts/ideogram.mjs` image script; the `mcc-art-director` and `mcc-ux-designer` repository agents

**Runtime:** plain CSS compiled from SCSS, and React 19 components on Base UI compiled to ESM. The admin app is a Vite React single-page app (spec 3). The player app is an Astro site that renders the same React components to static HTML and hydrates only interactive islands. Projects outside this repository can use `@hhh/css` with any framework or none.

**Deployment:** `@hhh/css` and `@hhh/react` publish to the public npm registry from GitHub Actions with npm trusted publishing when release-please cuts a release. Each app bundles the parts it imports and deploys with its own stack. Storybook publishes to Chromatic on every pull request and on `main`.

**Headless components:** Base UI (`@base-ui/react`, 1.x)

**Persistent state:** source-controlled tokens, SVG files, approved image masters and art manifests. Published package versions on npm. Nothing at runtime.

**External dependencies at runtime:** none. Fonts, images and code are served from each app's own origin. At design time: the Ideogram API (images) and Chromatic (visual review). At release time: the npm registry.

**Out of scope:** the admin sign-in page, which stays on the Cognito hosted login page (spec 3); Cognito user pools, app clients and identity provider configuration; app routing, data fetching and APIs, including how the player app loads its data (the player specification); building domain components such as the evidence viewer or the leaderboard podium (designed here, built under the app specifications, §7.2); a light theme; languages other than English; native apps; components for frameworks other than React

HH.H is the visual identity of the MCC stats suite: dark, Halo 3 inspired, and built for iPhone first. This spec defines its brand kit, an authoritative style guide expressed as tokens, a tree-shakeable open-source design system (framework-agnostic CSS plus React components) that the Vite admin app, the Astro player app and outside projects install from npm, the agent workflows that produce art, mockups and components, and the tests that hold the look, accessibility and mobile performance to fixed numbers. Agents do the work of a front-end developer, a graphic designer and a UX designer. A person approves brand art, mockups and every committed image.

---

## 1. Resolved requirement decisions

| Requirement | Decision | Reason |
| --- | --- | --- |
| Base UI as the component foundation, unless there is a better option | Base UI 1.x (`@base-ui/react`) supplies behavior and accessibility for interactive components: dialog, popover, menu, tooltip, tabs, select, combobox, checkbox, radio, switch, field, OTP field, toast, navigation menu. Static components (headings, buttons without state, cards, layout, tables) are plain React elements. | Base UI ships no styles, exposes state as `data-*` attributes that the CSS can target, and publishes each component as its own subpath. React Aria was the alternative; it is larger and its strengths (i18n, date pickers) are not needed here. Base UI has no table and no date picker; §7 covers both. |
| Works with a generic React app and an Astro app | One React implementation of every component. Astro renders React components to HTML at build time and ships no JavaScript for a component without a `client:*` directive. Each component is classified `static-safe` or `interactive` (§3.1). | Two implementations (React and `.astro`) would drift apart. The classification tells the player app which components cost zero JavaScript. |
| No Tailwind; SCSS modules | SCSS is the source, but it compiles to plain CSS with fixed, prefixed class names instead of CSS modules. Each component has one SCSS file that Sass compiles to its own CSS file in `@hhh/css` (`@hhh/css/button.css`). Classes follow `hhh-<block>`, `hhh-<block>__<element>` and `hhh-<block>--<modifier>`; component state comes from Base UI `data-*` attributes. Global CSS is limited to the reset, token custom properties and font faces. All design system CSS sits in cascade layers named `hhh.reset`, `hhh.tokens`, `hhh.base` and `hhh.components`. | CSS modules hash class names, so only a bundler and the React components could use them. Fixed class names let Vue, Svelte, Astro or plain HTML users style their own markup with `@hhh/css`. A consumer's own unlayered CSS beats every layered rule, so overrides need no specificity tricks, and the `hhh.` prefix keeps the layer and class names from colliding with a consumer's. |
| Extensible, with good defaults | Components work with no props beyond content. Each accepts `className`, exposes the CSS custom properties listed in its docs (such as `--hhh-button-bg`), and interactive components pass Base UI's `render` prop through for composition. | Defaults cover the common case. The three escape hatches cover restyling, theming one instance and changing the rendered element. |
| No bloat; tree shaking so each app ships only what it uses | `@hhh/css` publishes one CSS file per component plus `tokens.css` and `base.css`. `@hhh/react` publishes one subpath export per component (`@hhh/react/button`) with no root barrel, and each component module imports its own CSS file. `@hhh/react` marks `**/*.css` as a side effect. Both packages ship compiled output, and the apps in this repository consume that same output through npm workspaces. Size checks fail CI when a single-component import exceeds its budget (§9.2). | Barrel files defeat tree shaking in some bundlers and slow development servers. Testing the apps against the published output means outside users get exactly what the apps use. |
| Usable outside this project | `@hhh/css` and `@hhh/react` are MIT-licensed public packages on the npm registry, versioned with semantic versioning by release-please, and published by GitHub Actions through npm trusted publishing with provenance. The npm scope is `@hhh`, which a person reserves (§18). | GitHub Packages was considered and rejected: its npm registry requires an access token to install even public packages, so every outside user would have to create a token and edit `.npmrc`. npm trusted publishing needs no stored token. |
| Separate admin and player apps | Kept. The admin app is a Vite React app behind Cognito with MFA; the player app is an Astro site of mostly static pages. Both consume the published design system packages. | The player bundle never contains admin code or routes, the two apps sign in differently, and most player pages need no JavaScript. The design system does not need a single app to be shared, because both apps install the same packages. |
| Authoritative style guide | Design tokens in the Design Tokens Community Group format (`$value`, `$type`) under `packages/hhh-css/tokens/` are the source of truth. Style Dictionary builds them into CSS custom properties, an SCSS map and a TypeScript module. Storybook documentation pages render the built tokens, so the guide cannot disagree with the code. | A written guide that is separate from the code goes stale. |
| Show every proposed component, through a design service if possible | Storybook is the design surface, published to Chromatic. Mockups are coded page stories, not Figma frames. Reviewers open Chromatic links on an iPhone and approve or reject each story there. | Agents produce coded mockups as fast as frames, and the result shows real fonts, blur, motion and responsive behavior. A reviewer sees the real thing on the target device. Figma would add a second source of truth that no human designer maintains. |
| Ideogram for images | Raster art comes from the Ideogram API through `scripts/ideogram.mjs`. Every committed image was approved by a person and has a manifest entry (§6.1). | Approval keeps the art bill and the repository size under control. The manifest makes each image reproducible and replaceable. |
| Logo and vector creation by agents | The logo, icons, medals and emblems are SVG written by the art director agent. Ideogram concept sheets may come first; the committed artifact is always hand-written SVG. | Ideogram produces raster images only. SVG is sharp at every size, a few kilobytes, and themeable with tokens. |
| Halo-like figures without official images | Accepted likeness, recorded as the owner's decision: a detailed helmet in the style of the Halo 3 protagonist on the player sign-in screen, a Halo 3 style energy sword in the logo, and armored figures closely resembling the protagonist for the first, second and third place podium. No official images, screenshots used as art, logos, wordmarks or fonts. Prompts describe the look and never name a character. Likeness art, the logo and all generated raster art live only in the private `@mcc/art` workspace and are never published to npm. The published packages carry only original icons, medals and emblems. Both apps show the Game Content Usage Rules notice (§14). | The owner chose likeness for a non-commercial fan project. Keeping it out of the published packages confines it to this project's own site instead of a library others redistribute, and keeps the packages small. The art stays swappable through the manifest if that changes (§18). |
| Typeface: Square 721 or Eurostile Bold Extended (from the owner's reference notes) | Both are commercial fonts whose licenses do not allow self-hosting from a public repository. The display face is an open-licensed alternative: Saira (variable, width 50 to 125 and weight 100 to 900) by default, with Michroma as a specimen candidate. Body text uses the system font stack (`system-ui`, which is SF Pro on iPhone). The brand kit (P1.1) picks the final display face. | Saira covers condensed stat labels and extended Halo 3 style headings in one file. The system stack costs no download on the main target device. |
| Halo 3 translucent curved panels with `backdrop-filter` blur | Allowed only on the sign-in card, dialogs, bottom sheets and the top bar, each with an opaque fallback when `backdrop-filter` is unsupported or `prefers-reduced-transparency` is set. Never on list rows, table rows or repeated cards. | Blur on scrolling content is expensive on iOS Safari and would break the INP and frame-rate budgets. |
| Admin and player sign-in | The admin app keeps the Cognito hosted login page with username, password and MFA (spec 3). This spec supplies its logo, colors and background image as exported assets. The player app has a custom sign-in screen offering only single sign-on through Google, Microsoft and Apple, with no username or password fields (§8). | Custom admin sign-in would put admin credentials in our own JavaScript. Player sign-in through the authorize endpoint with a preselected provider never shows the hosted page, so it can be fully branded without handling any credential. |
| Admin app and player app need different components | Two tiers (§7). `@hhh/css` and `@hhh/react` hold components with no domain knowledge. Domain components live in each app and use the same Storybook, Chromatic, Vitest and Playwright harness. | A published package is a public contract: every breaking change is a major version for outside users, and every change updates both apps. Admin-only domain widgets would carry that cost with no reuse. The harness, not the package boundary, provides visual fidelity testing. |
| Dark theme | Dark only in v1. Tokens are split into primitive, semantic and component tiers so a later theme replaces only semantic values. | Both apps are dark by design; a light theme doubles visual testing for no current user. |
| Mobile-first, mostly iPhone, works on desktop | Styles are written for a 320 px wide viewport first and widen with `min-width` media queries and container queries. Playwright and Chromatic test 393 by 852 (iPhone 15 and 16) and 1440 by 900. | Most users are on iPhone. Container queries let a component adapt to the slot it sits in, not to the window. |

**Additional capabilities included:** a token contrast check that fails CI, size budgets per component, Lighthouse budgets on reference consumer apps, an SVG lint for medals and icons, an art manifest check, a published-files check that keeps art, stories and tests out of npm tarballs, and reduced motion and reduced transparency support in every component.

## 2. Goals and non-goals

### 2.1 Goals

1. An app imports one component and its bundle grows by that component's JavaScript and CSS only, measured by size checks on reference Vite and Astro apps.
2. A static player page built only from `static-safe` components ships no JavaScript.
3. Every component and mockup passes axe with no WCAG 2.2 AA violations and has Chromatic baselines at 393 and 1440 px.
4. The player reference pages meet the budgets in §9.1 under Lighthouse mobile emulation.
5. Every committed image has a person's approval and a manifest entry that reproduces it.
6. A Claude Code or Codex session can produce brand art, mockups or a component by following the repository agents, without a contributor's personal setup.
7. A project outside this repository installs `@hhh/css` or `@hhh/react` from npm with no access token, and a plain HTML page styled only with `@hhh/css` matches the React component's appearance.

### 2.2 Non-goals

- Branding the Cognito hosted login page beyond what Cognito's branding settings accept. The user pool owner applies the assets.
- Building domain screens. The app specifications own them; this spec designs them as mockups.
- Charts beyond a sparkline and a simple bar. A chart library is backlog (P4.1).
- Real-user performance monitoring. Lab budgets gate v1; field data is backlog (P4.3).
- Publishing to GitHub Packages (§1).
- Publishing the logo, likeness art or any generated raster art.
- Components for Vue, Svelte or other frameworks. Those users get `@hhh/css` and write their own markup.

## 3. Architecture

```text
packages/hhh-css/tokens/*.tokens.json (DTCG)
  |
  v  Style Dictionary (build)
@hhh/css dist/
  +-- tokens.css, tokens.scss, tokens.json   (layer `hhh.tokens`)
  +-- base.css                               (reset and font faces)
  +-- <component>.css                        (Sass build of src/<component>.scss; layer `hhh.components`)
  +-- icons/*.svg, medals/*.svg, emblems/*.svg
  |
  v  imported per component
@hhh/react dist/
  +-- <component>/index.js   (React; Base UI parts when interactive; imports @hhh/css/<component>.css)
  |
  v  npm registry (public)          and npm workspaces (this repository)
outside projects                    applications/admin (Vite SPA)       applications/player (Astro)
  React: @hhh/react                   every component hydrated            static-safe -> HTML only
  any other stack: @hhh/css                                               interactive -> island

packages/storybook  <-- stories from packages/hhh-react, applications/admin, applications/player
  +-- Vitest browser mode (interaction tests, axe)
  +-- Chromatic (hosted Storybook, visual baselines, human approval)

Art (private): brief -> scripts/ideogram.mjs -> candidates on the PR branch -> person approves
     -> packages/art/masters/*.webp + manifest.json -> build derivatives (AVIF, WebP) -> apps only
```

**Ownership rules:** only `scripts/ideogram.mjs` calls the Ideogram API. Only `packages/art/scripts/build-art.mjs` writes image derivatives. Component SCSS reads semantic and component tokens only, never primitives or literal colors. `@hhh/react` components render `@hhh/css` class names and never define styles of their own. Neither public package imports from `@mcc/art`, `packages/storybook` or `applications/*`. Apps import only package subpath exports, never internals.

**Packaging:** `@hhh/css` builds with Style Dictionary and Sass into `dist/`. `@hhh/react` builds with TypeScript into ESM with one module per component (`preserveModules`) and type declarations. Both declare `files` so their npm tarballs contain only `dist/`, `README.md`, `LICENSE` and `package.json`. Turbo builds both before any app. `@mcc/art` and `@mcc/storybook` are private: `@mcc/art` exports the logo, raster art derivatives and the Cognito assets to the two apps, and `@mcc/storybook` has no exports.

### 3.1 Rendering policy

| Class | Definition | Player app (Astro) | Admin app (Vite) |
| --- | --- | --- | --- |
| `static-safe` | Renders correct, complete HTML and CSS with no client JavaScript. No state, effects or event handlers are needed to show or use it; links and native form submission are allowed. | Rendered at build time with no `client:*` directive. Adds 0 bytes of JavaScript. | Hydrated as part of the app. |
| `interactive` | Needs client JavaScript to work (overlays, menus, sorting, uploads). | Used only inside an island. `client:visible` by default, `client:idle` for always-visible controls such as the tab bar menu. `client:load` needs a measured reason in the PR. | Hydrated as part of the app; route-level code splitting. |

- Each component's story declares its class in `parameters.hhh.rendering`, and the docs page and the package README show it.
- A `static-safe` component must not import Base UI or call hooks other than `useId`. A lint rule enforces this.
- Prefer platform features to JavaScript where they meet the UX bar: `<details>` for disclosure, the `popover` attribute for simple popovers, native `<input type="date">` and `<input type="datetime-local">`, CSS scroll snap for swipeable rows.

## 4. Brand

The brand kit (P1.1) and the first art set (P1.4) produce these artifacts, and a person approves them. Values below are starting values. After P1.3 the token files are authoritative.

### 4.1 Name and logo

- Name: **HH.H**. Page titles read `<Page> - HH.H`.
- Logo: a Halo 3 style energy sword with the HH.H wordmark beside or around it. Variants: full color on dark, single color (amber), single color (white), and a mark-only version legible at 32 px for favicons and app icons.
- The logo is SVG with outlined text, so no font file ships with it. It never contains the Halo logo, the Halo wordmark or Microsoft trademarks. It lives in `@mcc/art` and is not published.
- The open-source packages carry the HH.H name but no logo. Their READMEs describe them as a design system inspired by Halo 3 menus and state that they are not affiliated with or endorsed by Microsoft.
- Exported sizes for platforms: `favicon.svg`, 32 and 180 px PNG (`apple-touch-icon`), and 512 px PNG for a web manifest.

### 4.2 Palette

Direction: deep carbon and navy surfaces from the Halo 3 menus and the ring-in-clouds reference, Halo 3 amber for selection and primary actions, plasma blue as the secondary accent and glow, ember orange as a rare accent, and the saturated team red and blue of the MCC postgame screen.

| Primitive | Starting value | Semantic use |
| --- | --- | --- |
| `surface-0` | `#0A0F16` | Page background |
| `surface-1` | `#111925` | Raised surface, cards |
| `surface-2` | `#182334` | Selected row, inputs |
| `surface-3` | `#22314A` | Pressed, hover on desktop |
| `line` | `rgba(173, 200, 230, 0.16)` | Hairline borders and grids |
| `text-1` | `#E8EEF5` | Primary text |
| `text-2` | `#A9B6C6` | Secondary text |
| `text-3` | `#7C8A9C` | Muted text (meets 4.5:1 on `surface-0`) |
| `amber-500` | `#FBB040` | Primary action, selection bar, focus ring |
| `on-amber` | `#1A1205` | Text on amber |
| `plasma-400` | `#5CC8FF` | Secondary accent, links, info, glow |
| `ember-500` | `#FF7A3D` | Rare accent in art and highlights |
| `team-red` | `#D3202A` | Red team rows (white text) |
| `team-blue` | `#2457C5` | Blue team rows (white text) |
| `success` | `#3DDC97` | Success status |
| `warning` | `#F5C542` | Warning status, always with an icon so it is distinct from amber |
| `danger` | `#FF5A5F` | Errors and destructive actions |

Rules:

- Team color is never the only signal. Team rows carry the team name or a team label, and lists sort by team.
- Every text and background pair used by a semantic token meets WCAG 2.2 AA: 4.5:1 for body text, 3:1 for text at least 24 px (or 18.66 px bold) and for non-text indicators. The token check (§16.1) computes every pair.

### 4.3 Typography

| Role | Face | Mobile -> desktop size | Line height | Notes |
| --- | --- | --- | --- | --- |
| `display-xl` | Display, extended width, 800 | 40 -> 72 px | 1.05 | Sign-in and hero only |
| `display-l` | Display, extended, 700 | 32 -> 56 px | 1.05 | |
| `h1` | Display, extended, 700 | 28 -> 40 px | 1.15 | Uppercase |
| `h2` | Display, normal width, 700 | 22 -> 32 px | 1.15 | Uppercase |
| `h3` | Display, normal width, 600 | 18 -> 24 px | 1.2 | |
| `h4` | Display, condensed, 600 | 16 -> 20 px | 1.25 | |
| `body-l` | System | 18 px | 1.5 | |
| `body` | System | 16 px | 1.5 | Minimum size for form inputs |
| `body-s` | System | 14 px | 1.45 | |
| `caption` | System | 12 px | 1.35 | Smallest size allowed |
| `eyebrow` | Display, condensed, 600 | 12 -> 13 px | 1.2 | Uppercase, tracking 0.12em |
| `stat-l`, `stat-m`, `stat-s` | Display, condensed, 700 | 48, 32, 24 px | 1 | Tabular figures |

- Sizes between the mobile and desktop values scale with `clamp()` against the viewport width from 320 to 1440 px.
- Gamertags render in the body face at the surrounding size, never truncated without a full-text title and accessible name.
- Display font files are self-hosted, Latin subset, WOFF2, with `font-display: swap` and fallback `@font-face` rules whose `size-adjust`, `ascent-override` and `descent-override` match the display face, so swapping causes no layout shift.

### 4.4 Shape, texture and motion

- **Corners:** 45 degree cut corners (chamfers) in four sizes, 4, 8, 12 and 16 px, applied with a `chamfer()` SCSS mixin using `clip-path`. Because `clip-path` also clips `box-shadow`, glows are drawn by a `::before` layer behind the clipped element.
- **Lines:** 1 px hairlines in `line`. Focused cards show HUD corner brackets in amber.
- **Focus:** a 2 px amber outline at a 2 px offset on every focusable element, visible on keyboard focus (`:focus-visible`).
- **Selection:** the Halo 3 amber selection bar: an amber left edge and `surface-2` fill on the selected row or menu item.
- **Texture:** hexagon grids, brushed metal, light seams and Forerunner-style line glyphs as SVG patterns or CSS gradients, used in heroes, empty states and section dividers. Never raster textures behind text.
- **Motion:** durations of 90, 150, 220 and 320 ms with a standard ease `cubic-bezier(0.2, 0, 0, 1)`. Animate only `transform` and `opacity`. Under `prefers-reduced-motion: reduce`, transitions become opacity changes of at most 150 ms and decorative motion stops.

### 4.5 Imagery

| Asset | Where | Form |
| --- | --- | --- |
| Ring world above clouds and stars (after the owner's reference) | Player sign-in, heroes, admin hosted login background | Ideogram raster, layered: sky, ring, clouds |
| Detailed helmet in the style of the Halo 3 protagonist | Player sign-in hero | Ideogram raster, transparent background |
| Podium figures for first, second and third place | Player leaderboard podium | Ideogram raster, transparent background, three poses with gold, silver and bronze accents |
| Environments: snowy canyon structures, green valley under a ring, industrial bay | Empty and error states, section heroes | Ideogram raster |
| Medals and emblems | Player profiles, postgame, team pages | Hand-written original SVG (P1.2), published in `@hhh/css` |
| Icons | All components | Hand-written SVG, 24 px grid, 1.5 px stroke, square caps, mitered joins, published in `@hhh/css` |

- Raster assets in this table live in `@mcc/art` and are never published.
- Art direction: cold blue light, deep shadows, warm ember highlights, cinematic depth. No text inside generated images.
- Every raster image has a portrait mobile crop and a landscape desktop crop.
- The owner's downloaded ring wallpaper is a mood reference only and is never uploaded or committed.

### 4.6 Voice

Short, direct, game-literate. Labels use sentence case except where uppercase is part of the type role. Error messages say what happened and what to do. No exclamation marks in system messages.

## 5. Style guide and tokens

### 5.1 Token tiers and names

| Tier | Example | Who may use it |
| --- | --- | --- |
| Primitive | `color.amber.500`, `size.16` | Semantic tokens only |
| Semantic | `color.action.primary.bg`, `color.text.secondary`, `space.inline.m` | Components and apps |
| Component | `button.primary.bg`, `table.row.selected.border` | That component and app overrides |

CSS custom properties take the token path with a `--hhh-` prefix: `--hhh-color-action-primary-bg`.

### 5.2 Token groups

| Group | Values |
| --- | --- |
| Color | §4.2, plus overlays (`scrim` at 64 percent black) and glow colors |
| Typography | §4.3 roles as composite tokens: family, weight, width, size, line height, tracking, case |
| Space | 0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96 px |
| Breakpoints | `sm` 480, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536 px, used as `min-width` only |
| Containers | `content` 720, `wide` 1200, `full` 1536 px maximum widths |
| Shape | chamfer 4, 8, 12, 16 px; hairline 1 px; focus ring 2 px at 2 px offset |
| Elevation | `glow-amber`, `glow-plasma` at three strengths; `shadow-sheet` for sheets |
| Motion | §4.4 durations and easings |
| Layers (`z-index`) | base 0, sticky 100, nav 200, overlay 300, toast 400, tooltip 500 |
| Safe areas | `env(safe-area-inset-*)` exposed as `--hhh-safe-top`, `--hhh-safe-bottom`, `--hhh-safe-left`, `--hhh-safe-right` |
| Touch | minimum target 44 by 44 CSS px |

### 5.3 Rules

1. Component SCSS uses only semantic and component tokens. A Stylelint rule rejects literal colors, font sizes, `z-index` values and spacing in component styles.
2. Every class selector starts with `hhh-` and follows the block, element and modifier pattern in §1. Every rule sits inside an `hhh.` layer. Stylelint enforces both. Class names are part of the public API: renaming or removing one is a breaking change.
3. Styles are mobile first. Component layout responds to `@container` queries; page layout responds to `min-width` media queries.
4. Use `100dvh`, never `100vh`, for full-height layouts.
5. Inputs use at least 16 px text so iOS Safari does not zoom on focus.
6. `-webkit-tap-highlight-color` is transparent, and every pressable element shows its own pressed state.

## 6. Agent workflows

Two repository roles join `mcc-implementer`, generated for Claude Code and Codex from `.agents/` (P0.3).

| Human role replaced | Repository agent | Produces |
| --- | --- | --- |
| Graphic designer | `mcc-art-director` | Briefs, Ideogram batches, contact sheets, approved masters and manifest entries, SVG logo, icons, medals and emblems |
| UX designer | `mcc-ux-designer` | Flows, wireframes, mockup stories, self-review against heuristics and accessibility, review packets |
| Front-end developer | `mcc-implementer` (existing) | Components, stories, tests, size budgets |

Both new roles use Playwright MCP for screenshots (P0.2). Playwriter attaches to a person's own Chrome and is used only when that person connects a tab.

### 6.1 Image flow

1. The art director writes a brief per asset: purpose, placement, crops, palette, references by description, and likeness rules from §1.
2. `scripts/ideogram.mjs` runs one batch: at most 8 images per brief and a per-batch cost cap (default 5 USD, `--max-usd` to change). It refuses to start when the estimated cost exceeds the cap, and refuses to run without `IDEOGRAM_API_KEY`.
3. Candidates are converted to WebP (quality 85) and committed on the pull request branch under `packages/art/candidates/<brief-id>/`, with a generated contact sheet in the PR body.
4. A person approves candidates by ID in a PR comment. Raising the cap for a batch needs the same approval.
5. The art director moves approved images to `packages/art/masters/` (WebP, quality 90, longest side at most 2560 px), adds manifest entries, and deletes `candidates/` before the PR is marked ready. Squash merge keeps rejected candidates out of `main`.
6. The art build creates derivatives at widths 480, 768, 1080, 1440, 1920 and 2560 in AVIF (quality 50) and WebP (quality 70) plus a 16 px blurred placeholder, under the ignored `packages/art/dist/`.
7. Original SVG medals, emblems and icons follow the same approval step but are committed to `packages/hhh-css/src/` with entries in that package's own manifest.

### 6.2 Mockup flow

1. The UX designer writes the flow for each screen: entry points, primary task, states (loading, empty, error, success) and exit.
2. It builds the screen as a page story in the app's `mockups/` directory from tokens and existing components, with quick markup where a component does not exist yet.
3. It screenshots each story with Playwright MCP at 393 and 1440 px, reviews the screenshots against the style guide, WCAG 2.2 AA, one-handed reach on a phone, and Nielsen's ten heuristics, fixes what it finds, and repeats until a pass finds nothing.
4. The review packet in the PR body lists each screen with its Chromatic link, screenshots, the findings and their fixes.
5. A person approves each screen in Chromatic. Approved snapshots become the baselines that the real screen's story must match when it is built. Mockup stories are deleted when the real screen ships.

### 6.3 Component flow

`mcc-implementer` builds each component slice from the approved mockups and this spec: the SCSS in `@hhh/css`, the React component in `@hhh/react`, stories with play functions, a plain HTML story that uses only the CSS classes, rendering class, docs, and size budget. Chromatic diffs against the mockup baselines show where the component differs from what was approved.

## 7. Component catalog

### 7.1 Design system tier (`@hhh/css` and `@hhh/react`)

Every component below has a CSS file in `@hhh/css` and a React component in `@hhh/react`.

| Slice | Components | Class | Base UI parts |
| --- | --- | --- | --- |
| Typography (P3.1) | `Heading`, `Text`, `Eyebrow`, `StatValue`, `Gamertag`, `VisuallyHidden` | static-safe | none |
| Buttons (P3.2) | `Button` (primary, secondary, ghost, destructive), `IconButton`, `LinkButton`, `ToggleButton`, `SegmentedControl` | `Button`, `IconButton`, `LinkButton` static-safe; others interactive | Toggle, ToggleGroup |
| Layout and navigation (P3.3) | `AppShell`, `TopBar`, `BottomTabBar`, `SideRail`, `Stack`, `Cluster`, `Grid`, `Container`, `Card`, `Breadcrumbs`, `SkipLink` | static-safe except the mobile menu | NavigationMenu, Menu |
| Forms (P3.4, P3.9) | `Field`, `TextInput`, `PasswordInput`, `Select`, `Combobox`, `Checkbox`, `Radio`, `Switch`, `DateInput` (native), `OtpField`, `UploadField` | interactive except `Field`, `TextInput`, `DateInput` | Field, Select, Combobox, Checkbox, Radio, Switch, OTPField |
| Sign-in (P3.5) | `AuthLayout`, `SsoButton` (Google, Microsoft, Apple) | static-safe | none |
| Overlays (P3.6) | `Dialog`, `BottomSheet`, `Popover`, `Menu`, `Tooltip`, `Toast` | interactive | Dialog, Popover, Menu, Tooltip, Toast |
| Data display (P3.7) | `DataTable`, `DataList`, `TeamGroup`, `RankRow`, `StatTile`, `Sparkline`, `BarMeter` | static-safe; sorting is an interactive add-on | none |
| Feedback and status (P3.8) | `Badge`, `StatusBadge`, `Alert`, `Banner`, `Progress`, `Spinner`, `Skeleton`, `EmptyState`, `ErrorState` | static-safe | Progress |
| Icons and art (P1.2, P3.8) | `Icon`, medal and emblem SVGs, `ArtImage` (responsive `<picture>` that takes sources and a placeholder from the caller) | static-safe | none |

The logo and the generated art are not components. The apps import them from `@mcc/art`.

Notes:

- `DataTable` renders a semantic `<table>`. On phones it keeps the first column sticky and shows a scroll shadow when content overflows. `DataList` renders cards below the `md` container width and a table above it, from the same column definitions.
- `TeamGroup` groups `DataTable` rows under a team header with the team color token and team label. Postgame scoreboards in both apps are built from it.
- `UploadField` handles picking several images from the iPhone photo library, per-file progress and retry. The admin app owns the match upload flow (spec 8).
- `Sparkline` and `BarMeter` are hand-written SVG with no chart library.

### 7.2 App tier

Designed in the mockups (P2.1, P2.2) and built under each app's specification.

| App | Domain component | Built from |
| --- | --- | --- |
| Player | Sign-in screen | `AuthLayout`, `SsoButton`, art |
| Player | Home, service record hero | `Card`, `StatTile`, `Heading`, emblem |
| Player | Match postgame | `TeamGroup`, `DataTable`, medals |
| Player | Leaderboard with podium | `RankRow`, podium art, `DataList` |
| Player | Medal case | medal SVGs, `Grid` |
| Admin | Match upload | `UploadField`, `Field`, `Progress` (spec 8) |
| Admin | Match list | `DataList`, `StatusBadge` |
| Admin | Review queue and evidence viewer | `BottomSheet`, `Button`; pinch zoom and cell overlays are app code (spec 3) |
| Admin | Roster | `DataTable`, `Dialog`, forms (spec 6) |

A domain component moves into the published packages only when its domain knowledge can be removed and both apps need it.

## 8. Sign-in

### 8.1 Player

- The sign-in screen offers three buttons: Continue with Google, Continue with Microsoft, Continue with Apple. There are no username, password or email fields, and no account creation form.
- `SsoButton` takes `provider` and `href`. The player app builds each `href` to its user pool's authorize endpoint with `identity_provider` set to `Google`, `SignInWithApple`, or the name it gives its Microsoft OIDC provider, plus PKCE and `state`. Cognito then skips its hosted page. `SsoButton` knows nothing about Cognito.
- Each button follows its provider's published branding: Google's sign-in button guidelines, Microsoft's sign-in branding guidance, and Apple's Human Interface Guidelines for Sign in with Apple. These buttons are the one place where provider rules override the HH.H style. They sit on a HH.H card, in a fixed order, at full width on phones.
- `AuthLayout` takes its art layers as props, so the published component carries no art. The player app passes the ring, clouds and helmet from `@mcc/art` as separate AVIF layers with a portrait crop on phones and a landscape crop on desktop. The helmet layer has `fetchpriority="high"` and is the LCP element. CSS-only motion (slow ring drift, star twinkle) stops under reduced motion.
- States: default, redirecting (button shows progress and the others disable), provider error (an `Alert` with retry), and session expired (a `Banner` above the buttons).
- The page shows the Game Content Usage Rules notice in its footer (§14).

### 8.2 Admin

The admin app uses the Cognito hosted login page with username, password and MFA, as spec 3 defines. This spec exports the logo (SVG and PNG), the ring background image at the sizes Cognito branding accepts, and the palette as hex values in `packages/art/cognito/`. Applying them to the user pool belongs to the infrastructure that owns it.

## 9. Performance and accessibility budgets

### 9.1 Page budgets (Lighthouse CI, mobile emulation, reference apps)

| Metric | Budget |
| --- | --- |
| Largest Contentful Paint | at most 2.0 s |
| Total Blocking Time (lab proxy for INP) | at most 150 ms |
| Cumulative Layout Shift | at most 0.05 |
| JavaScript on a static player page | 0 bytes |
| JavaScript on a player page with islands | at most 80 KB gzip, including React |
| JavaScript on an admin route at first load | at most 150 KB gzip |
| CSS per page | at most 25 KB gzip |
| Fonts per page | at most 80 KB WOFF2, one preloaded file |
| LCP image | at most 100 KB on mobile, 250 KB on desktop |
| Lighthouse performance and accessibility scores | at least 95 and 100 |

Field INP stays at most 200 ms at the 75th percentile once real-user measurement exists (P4.3).

### 9.2 Component budgets (size checks)

| Import | Budget (gzip) |
| --- | --- |
| One static-safe component, JavaScript excluding React | 2 KB |
| One static-safe component, CSS | 3 KB |
| One interactive component, JavaScript including its Base UI parts | 15 KB |
| One medal or emblem SVG | 4 KB |
| Tokens CSS | 6 KB |

### 9.3 Accessibility

- WCAG 2.2 AA for every component, mockup and screen.
- Touch targets at least 44 by 44 CSS px.
- Keyboard: every interactive component works with keyboard alone on desktop, with a visible focus ring and a logical order. Overlays trap focus and restore it on close.
- Screen readers: every control has an accessible name. Status changes announce through a live region. Icons that carry meaning have labels; decorative art has empty `alt`.
- Content reflows at 320 px wide and at 200 percent zoom with no loss of content.
- Nothing relies on hover or on color alone.

### 9.4 Supported browsers

iOS Safari 17 and later (the primary target), and the latest two major versions of Safari, Chrome, Edge and Firefox on desktop and Android. This allows CSS nesting, container queries, `:has()`, cascade layers, the `popover` attribute and `color-mix()` without fallbacks.

## 10. Typed domain model

### 10.1 Core types

```typescript
// @hhh/react/types
type RenderingClass = 'static-safe' | 'interactive';

type SsoProvider = 'google' | 'microsoft' | 'apple';

type TeamColor = 'red' | 'blue';

interface ComponentDocsParameters {
  readonly rendering: RenderingClass;
  readonly cssVariables: readonly string[]; // documented override points
  readonly budgetBytes: { readonly js: number; readonly css: number };
}

// packages/art/manifest.json and packages/hhh-css/art-manifest.json,
// schemaVersion `mcc-art-manifest/v1`
interface ArtManifestEntry {
  readonly id: string; // kebab-case, unique, stable
  readonly file: string; // path relative to the manifest's package
  readonly kind: 'raster' | 'vector';
  readonly briefId: string;
  readonly usage: readonly string[]; // components or screens that use it
  readonly likeness: boolean; // true for assets under the §1 likeness decision
  readonly generation?: {
    readonly provider: 'ideogram';
    readonly model: string;
    readonly prompt: string;
    readonly negativePrompt?: string;
    readonly seed: number;
    readonly aspectRatio: string;
    readonly costUsd: number;
    readonly createdAt: string; // ISO 8601
  };
  readonly approval: {
    readonly approver: string; // GitHub login
    readonly reference: string; // PR comment URL
    readonly approvedAt: string;
  };
  readonly crops: readonly { readonly name: 'mobile' | 'desktop'; readonly x: number; readonly y: number; readonly width: number; readonly height: number }[];
  readonly placeholder: string; // data URI, at most 1 KB
}
```

Validation: the art check (§16.1) rejects a master without an entry, an entry without a file, a raster entry without `generation` and `approval`, a master whose longest side exceeds 2560 px, any file under `packages/art/candidates/` on `main`, and any `likeness: true` or raster entry in the `@hhh/css` manifest. Prompts never contain personal data.

### 10.2 Relationships

```text
Token (primitive) 1 -> many Token (semantic) 1 -> many Token (component)
Component 1 -> 1 CSS file in @hhh/css, 1 -> 1 React component in @hhh/react, 1 -> many stories, 0..many -> Base UI parts
ArtManifestEntry 1 -> 1 master file, 1 -> many derivatives
Mockup story 1 -> 1 approved Chromatic baseline -> 1 real screen story
```

## 11. Module catalog

### 11.1 `packages/hhh-css` (`@hhh/css`, public)

| File | Exports | Purpose |
| --- | --- | --- |
| `src/<component>.scss` | `dist/<component>.css` | One CSS file per component |
| `src/base.scss` | `dist/base.css` | Reset, font faces, layer order |
| `src/_mixins.scss` | `chamfer()`, `glow()`, `container()`, `bp()`, `focus-ring()`, `reduced-motion()` | Shared SCSS helpers; also published for SCSS users |
| `src/icons/`, `src/medals/`, `src/emblems/` | `dist/icons/*.svg` and the same for medals and emblems | Original SVG art |
| `scripts/build-tokens.mjs` | `dist/tokens.css`, `dist/tokens.scss`, `dist/tokens.json` | Style Dictionary build |
| `scripts/check-contrast.mjs` | none | Token contrast check |

### 11.2 `packages/hhh-react` (`@hhh/react`, public)

| File | Exports | Purpose |
| --- | --- | --- |
| `src/<component>/index.ts` | the component and its prop types | One subpath export per component |
| `scripts/build-icons.mjs` | `@hhh/react/icons/<name>` | Generates one icon component per `@hhh/css` icon |

### 11.3 `packages/art` (`@mcc/art`, private)

| File | Exports | Purpose |
| --- | --- | --- |
| `scripts/build-art.mjs` | `dist/` derivatives and placeholders | Responsive images with `sharp` |
| `scripts/check-art.mjs` | none | Manifest check (§10.1) for both manifests |
| `svg/logo/` | logo variants | HH.H logo |
| `cognito/` | none | Assets for the admin hosted login |

### 11.4 Repository scripts and agents

| File | Purpose |
| --- | --- |
| `scripts/ideogram.mjs` | Ideogram batch generation with key, cap and output rules (§6.1) |
| `.agents/roles/mcc-art-director.*`, `.agents/roles/mcc-ux-designer.*` | Role sources; generated into `.claude/` and `.codex/` |

## 12. Directory structure and ownership

```text
packages/hhh-css/                  # @hhh/css, public on npm
  tokens/                          # DTCG token sources (authoritative style guide)
  src/                             # component SCSS, base, mixins, icons, medals, emblems
  art-manifest.json                # approvals for the original SVG art
  test/html/                       # plain HTML pages that use only the CSS
  dist/                            # build output (ignored; the only published code)
packages/hhh-react/                # @hhh/react, public on npm
  src/<component>/                 # component, stories, tests
  test/consumers/vite/             # reference Vite React app for size and Lighthouse checks
  test/consumers/astro/            # reference Astro app for size, zero-JS and Lighthouse checks
  dist/                            # build output (ignored; the only published code)
packages/art/                      # @mcc/art, private
  masters/                         # approved raster masters (WebP)
  svg/logo/                        # logo variants
  cognito/                         # exported assets for the admin hosted login
  manifest.json
  dist/                            # generated derivatives (ignored)
packages/storybook/                # @mcc/storybook, private: shared Storybook and Vitest browser config
applications/admin/.../mockups/    # admin mockup stories (removed when screens ship)
applications/player/.../mockups/   # player mockup stories (removed when screens ship)
scripts/ideogram.mjs
```

Import rules: `@hhh/css` imports nothing. `@hhh/react` imports only `@hhh/css`, `@base-ui/react` and React. Neither imports `@mcc/art`, `packages/storybook` or `applications/*`. Apps import only package subpath exports. ESLint enforces these rules, and the published-files check (§16.1) proves the tarballs contain nothing else.

## 13. Configuration and infrastructure

### 13.1 Configuration

| Setting | Where | Notes |
| --- | --- | --- |
| `IDEOGRAM_API_KEY` | Local environment of the person or agent running `scripts/ideogram.mjs` | Never committed, logged or passed to CI |
| `CHROMATIC_PROJECT_TOKEN` | GitHub Actions secret, added by a person | Read only by the Chromatic workflow |
| npm trusted publishers | npmjs.com package settings for `@hhh/css` and `@hhh/react`, configured by a person | Names this repository and the publish workflow file. No npm token is stored anywhere. |
| Viewports | `packages/storybook` config | 393 by 852 and 1440 by 900 |

### 13.2 Infrastructure

None. The design system creates no AWS resources. Apps serve fonts and images from their own CloudFront distributions.

### 13.3 Deployment

- Chromatic publishes Storybook for each pull request and for `main`.
- When release-please merges a release PR that bumps `@hhh/css` or `@hhh/react`, the publish workflow builds the package, runs the published-files check and `npm publish` with `id-token: write`. npm trusted publishing authenticates through GitHub OIDC and attaches provenance.
- `@hhh/css` publishes before `@hhh/react` when both change, because `@hhh/react` depends on the matching `@hhh/css` version.
- A person reserves the `@hhh` scope, configures the trusted publishers, and does any first publish that npm requires before a trusted publisher can be configured. Publishing never uses a long-lived token.
- Apps deploy the design system as part of their own bundles through their own stacks.

## 14. Security, privacy and legal

1. No API keys in the repository, logs, stories, manifests or CI output. The Ideogram key stays local.
2. Prompts, briefs and manifests contain no personal data, gamertags of real people or account details.
3. Playwriter controls a person's real browser. Agents use it only on tabs that person connects and never on cloud consoles or account settings.
4. Components render user-supplied text (gamertags, notes) as text, never as HTML. No component uses `dangerouslySetInnerHTML`.
5. Components work under a Content Security Policy without `unsafe-eval` and without inline `<script>`. Dynamic positions are set through the CSS Object Model, not inline style strings in server HTML.
6. Both apps and Storybook show this notice, quoted verbatim from the rules' required form, with a link to the Game Content Usage Rules (`https://www.xbox.com/en-US/developers/rules`), because they display Halo screenshots and Halo-inspired art: "Halo: The Master Chief Collection © Microsoft Corporation. HH.H was created under Microsoft's "Game Content Usage Rules" using assets from Halo: The Master Chief Collection, and it is not endorsed by or affiliated with Microsoft."
7. HH.H stays non-commercial: no ads, payments or paywalls. Its logo never uses a game logo, and no title suggests Microsoft made or endorses it.
8. The published packages contain no Game Content: no screenshots, likeness art, logo or generated raster art. Their package names and descriptions do not use "Halo" as a name; a README may say "inspired by Halo 3 menus" and carries the non-affiliation statement.
9. Releases are published only by the publish workflow through npm trusted publishing with provenance. The workflow has `id-token: write` and `contents: read` and no other secrets, and runs only for release-please releases on `main`.

## 15. Observability

- Lighthouse CI reports per pull request for the reference apps, with the budget table from §9.1.
- Chromatic build history records every approved baseline and who approved it.
- The art manifest is the audit record for "where did this image come from and who approved it".
- Size check output in CI lists each subpath's bytes against its budget.

## 16. Testing, CI and release

### 16.1 Tests

| Layer | Covers |
| --- | --- |
| Token tests (`node --test`) | DTCG validity, naming, tier rules, contrast for every semantic text and background pair |
| Stylelint (SCSS) | No literal colors, sizes, spacing or `z-index` in component styles; `hhh-` class names; every rule in an `hhh.` layer |
| ESLint | Import boundaries, no root barrel, no Base UI or hooks in `static-safe` components |
| Vitest browser mode via the Storybook Vitest addon (Chromium and WebKit) | Every story renders; play functions test interaction, focus and keyboard; axe reports no WCAG 2.2 AA violation |
| CSS-only pages (`packages/hhh-css/test/html/`) | Each component's plain HTML story matches its React story in Chromatic, proving `@hhh/css` works without React |
| Published-files check | `npm pack --dry-run` for both public packages lists only `dist/`, `README.md`, `LICENSE` and `package.json`, with no stories, tests, source maps of private files or art from `@mcc/art` |
| Clean install check | The reference apps install the packed tarballs from a temporary directory with no workspace links and no registry token, then build |
| Chromatic | Visual baselines at 393 and 1440 px for every story, including mockups |
| Playwright (reference apps) | WebKit with the iPhone 15 profile and Chromium desktop: zero script requests on a static Astro page, islands hydrate on view, reduced motion and reduced transparency emulation, safe-area layout, keyboard flows |
| Size checks | §9.2 budgets per subpath from the reference apps |
| Lighthouse CI | §9.1 budgets on the reference apps |
| SVG lint | `viewBox` present, no embedded raster, no `<script>` or event attributes, optimized, size budget |
| Art check | §10.1 manifest rules |
| `scripts/ideogram.mjs` tests | Missing key refusal, cost cap refusal, key never printed, output paths; HTTP is mocked |

Tests never call Ideogram, Chromatic or AWS. A real-iPhone check of the hosted Storybook is a manual step for each mockup approval and each component slice.

### 16.2 CI and release

CI runs token, lint, unit, Vitest browser, size, art and published-files checks for any change to `packages/hhh-css`, `packages/hhh-react`, `packages/art`, `packages/storybook` or an app's stories, and Chromatic and Lighthouse CI on pull requests that touch them. New workflows follow the repository's GitHub Actions naming convention.

P0.4 adds the four new workspaces to `package-lock.json`, `.release-please-manifest.json` and `release-please-config.json`, and `npm run release:check` passes. `@hhh/css` and `@hhh/react` start at version 0.1.0 and stay below 1.0.0 until P3 is complete; from 1.0.0 on, a removed or renamed class, prop, token or subpath is a major version. `@mcc/art` and `@mcc/storybook` are private at 1.0.0. Release-please writes each public package's changelog, and the publish workflow (§13.3) runs on its releases.

## 17. Acceptance criteria

- [ ] Importing only `@hhh/react/button` into the reference Vite app adds no other component's JavaScript or CSS to the bundle.
- [ ] A plain HTML page that links only `@hhh/css/tokens.css`, `base.css` and `button.css` renders a button that matches the React story in Chromatic.
- [ ] `npm install @hhh/css @hhh/react` works in an empty project with no registry configuration or token, and the npm package pages show provenance from this repository.
- [ ] The published tarballs contain no likeness art, logo, generated raster art, stories or tests.
- [ ] A reference Astro page built only from static-safe components loads with zero script requests in Playwright WebKit.
- [ ] Every story passes axe in Vitest browser mode on Chromium and WebKit and has approved Chromatic baselines at both viewports.
- [ ] The token check fails when a semantic text and background pair falls below the §4.2 contrast rule.
- [ ] Reference app pages meet every §9.1 budget in Lighthouse CI.
- [ ] Every file under `packages/art/masters/` and every SVG in `@hhh/css` has a manifest entry with a person's approval, and `main` has no `packages/art/candidates/`.
- [ ] The player sign-in components show only the Google, Microsoft and Apple buttons, follow each provider's branding, and show the Game Content Usage Rules notice.
- [ ] The admin hosted login assets exist in `packages/art/cognito/`.
- [ ] The `mcc-art-director` and `mcc-ux-designer` roles exist for Claude Code and Codex and pass `npm run agents:check`.

## 18. Risks and accepted limitations

1. **Likeness:** the helmet, sword and podium figures resemble a copyrighted character and item. The Game Content Usage Rules grant a revocable license for non-commercial use, and Microsoft could still ask for removal. Accepted by the owner. The manifest's `likeness` flag lists every affected asset, so replacement is one PR per asset.
2. **License to Microsoft:** under the Game Content Usage Rules, sharing an item grants Microsoft a royalty-free license to use it. Accepted; HH.H art is not a commercial asset.
3. **Sign in with Apple needs a paid Apple Developer account** for the Services ID and key. The player specification owns that cost and setup. Until it exists, the Apple button stays hidden by configuration.
4. **Lab metrics are not field metrics:** Lighthouse emulation approximates a mid-range phone. Real-user INP and LCP wait for P4.3.
5. **Chromatic plan limits:** two viewports for every story may exceed the free snapshot quota. P0.5 measures usage and reports whether a paid plan or TurboSnap is needed; a person decides.
6. **Generated art consistency:** Ideogram results vary between batches. Character references and recorded seeds reduce drift but do not remove it; a person approves every image.
7. **Display font size:** Saira with both axes may exceed the 80 KB font budget. P1.3 measures it and restricts the weight or width range if needed.
8. **Provider button rules limit the brand:** the Google, Microsoft and Apple buttons cannot take the HH.H shape or colors.
9. **Playwright WebKit is not iOS Safari:** it shares the engine but not every platform behavior (safe areas, keyboard, scroll). The manual real-iPhone check covers the gap.
10. **npm scope availability:** the `@hhh/css` and `@hhh/react` packages do not exist on npm today, but whether the `@hhh` scope is free could not be confirmed without an npm account. A person reserves it before P3.10. If it is taken, a person picks another scope, and P3.10 renames the packages and every import in the same PR.
11. **Public API cost:** class names, props, tokens and subpaths become a public contract, so changes need versioning discipline even when only this project's apps use them. The 0.x range during P3 keeps early changes cheap.
12. **First publish:** npm appears to require a package to exist before a trusted publisher can be configured for it. If so, a person publishes 0.1.0 once by hand, configures the trusted publisher, and every later release goes through the workflow.

## 19. Reference documentation

- Base UI: https://base-ui.com/react/overview/quick-start
- Base UI releases: https://base-ui.com/react/overview/releases
- Astro framework components (React islands and directives): https://docs.astro.build/en/guides/framework-components/
- Design Tokens Community Group format: https://www.designtokens.org/tr/drafts/format/
- Style Dictionary: https://styledictionary.com/
- Storybook AI and MCP: https://storybook.js.org/docs/ai
- Storybook Vitest addon: https://storybook.js.org/docs/writing-tests/integrations/vitest-addon
- Chromatic: https://www.chromatic.com/docs/
- Playwright MCP: https://github.com/microsoft/playwright-mcp
- Playwriter: https://github.com/remorses/playwriter
- Ideogram API: https://developer.ideogram.ai/
- Amazon Cognito authorize endpoint: https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html
- Google sign-in branding: https://developers.google.com/identity/branding-guidelines
- Sign in with Apple, Human Interface Guidelines: https://developer.apple.com/design/human-interface-guidelines/sign-in-with-apple
- Microsoft identity platform sign-in branding: https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-branding-in-apps
- Game Content Usage Rules: https://www.xbox.com/en-US/developers/rules
- npm trusted publishing: https://docs.npmjs.com/trusted-publishers
- GitHub Packages npm registry (token required to install): https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry
- CSS cascade layers: https://developer.mozilla.org/en-US/docs/Web/CSS/@layer
- WCAG 2.2: https://www.w3.org/TR/WCAG22/

## 20. Delivery plan: phases and slices

This section is the backlog source for building the design system. Nothing below is filed until a person has reviewed this spec, except P0.1 (#228) and P0.2 (#229).

### 20.1 How to file this plan

- Each phase becomes one epic, titled with the phase title, with its goal and exit criteria as the body. Create epics only when someone explicitly asks for filing.
- Each slice becomes one leaf issue under its phase epic, titled without its code, with `Plan ID: P<n>.<m>` in the body. File with `/mcc-create-github-issue`.
- Size is XS, S or M. Split a slice by independently testable behavior when it outgrows one reviewable PR; the original Plan ID becomes the container.
- Blocked by lists Plan IDs. Create native blocked-by links after every issue in the batch exists.
- Acceptance bullets become the issue's acceptance criteria verbatim. Every slice also inherits §20.3.
- Spec lists the sections the implementer must read. Link them; this document stays the source of truth.
- Plan IDs are stable. Deferred slices keep their IDs and move to the backlog phase; new slices take the next free number in their phase.

### 20.2 Seam contracts

| Contract | Defined in | Main consumers |
| --- | --- | --- |
| Token names and tiers (§5.1) | P1.3 | Every component, both apps |
| `@hhh/react` subpath export per component, no root barrel (§1) | P0.4 | Both apps, outside React users |
| `@hhh/css` file per component and `hhh-` class names (§1, §5.3) | P0.4 | `@hhh/react`, outside users of any framework |
| Rendering class (§3.1) | P0.4 | Player app islands |
| Art manifest `mcc-art-manifest/v1` (§10.1) | P0.3 | Art check, both apps |
| `SsoButton` `provider` and `href` props (§8.1) | P3.5 | Player app sign-in |

A change to a contract updates every consumer in the same PR.

### 20.3 Definition of done for every slice

- Components use tokens only, declare their rendering class, and stay within their §9.2 budget.
- Every story passes axe and interaction tests and has Chromatic baselines at 393 and 1440 px.
- Every component has a plain HTML story that uses only `@hhh/css` classes and matches its React story.
- Each public package's README documents the new component's classes, props, CSS custom properties and rendering class.
- Touch targets are at least 44 by 44 CSS px, and focus is visible.
- The repository checks for the changed paths pass (`AGENTS.md` checks table), including `npm run check` for workspace changes.
- No real credentials, personal data or real players' gamertags in stories, fixtures or prompts. Fixture gamertags are invented.
- A real-iPhone check of the hosted Storybook is recorded in the PR.

### Phase 0: Specification and tooling

**Goal:** the spec, browser tools for agents, the design agents, and the package and test harness exist.
**Exit criteria:** a sample component in `@hhh/css` and `@hhh/react` runs through Vitest browser, Chromatic, the size, Lighthouse and published-files checks in CI.

#### P0.1 Specify the HH.H design system (S)

- **Filed as:** #228
- **Blocked by:** none
- **Spec:** this document
- **Files:** `specs/10-design-system.md`
- **Acceptance:** a person reviewed and approved this spec.

#### P0.2 Configure Playwright MCP and Playwriter for repository agents (S)

- **Filed as:** #229
- **Blocked by:** none
- **Spec:** §6, §14
- **Files:** the Claude Code and Codex MCP configuration, `.agents/README.md`
- **Acceptance:** as written in #229.

#### P0.3 Design agents for art direction and UX design (M)

- **Blocked by:** P0.1, P0.2
- **Spec:** §6, §10.1, §13.1, §14
- **Files:** `.agents/roles/`, `.agents/policy.json`, generated `.claude/` and `.codex/` output, `scripts/ideogram.mjs` and its tests
- **Provides:** `mcc-art-director`, `mcc-ux-designer`, the Ideogram script and the art manifest schema
- **Acceptance:**
  - `mcc-art-director` runs the §6.1 image flow and writes the logo, icons and medals as SVG.
  - `mcc-ux-designer` runs the §6.2 mockup flow and assembles a review packet.
  - The Ideogram script reads `IDEOGRAM_API_KEY`, refuses to run without it, never prints it, and enforces the batch cap.
  - `.agents/policy.json` names model and effort for both roles, and `npm run agents:check` passes.

#### P0.4 Design system packages, Storybook and Vitest browser (M)

- **Blocked by:** P0.1
- **Spec:** §1, §3, §3.1, §11, §12, §16
- **Files:** `packages/hhh-css`, `packages/hhh-react`, `packages/art`, `packages/storybook`, `packages/hhh-react/test/consumers/`, workspace and release metadata
- **Provides:** the per-component CSS files and class naming, `@hhh/react` subpath exports, the rendering class parameter, the shared Storybook, the reference Vite and Astro apps
- **Acceptance:**
  - `@hhh/css` compiles one sample component's SCSS to its own CSS file with `hhh-` classes inside `hhh.` layers.
  - `@hhh/react` builds to ESM with one module per component, type declarations and per-component subpath exports, and its sample component imports its CSS file.
  - One Storybook collects stories from `packages/hhh-react`, `packages/hhh-css/test/html`, `applications/admin` and `applications/player`.
  - Vitest browser mode runs every story on Chromium and WebKit with interaction tests and axe.
  - The sample component imported alone into the reference Vite app adds no other component's code.
  - `npm pack --dry-run` for both public packages lists only `dist/`, `README.md`, `LICENSE` and `package.json`, and both declare the MIT license.
  - `npm run release:check` passes with the four new workspaces.

#### P0.5 Visual, browser and performance checks in CI (M)

- **Blocked by:** P0.4
- **Spec:** §9, §15, §16
- **Files:** Chromatic, Playwright, size check and Lighthouse CI configuration, and the GitHub Actions workflows that run them
- **Acceptance:**
  - Chromatic publishes Storybook and runs visual tests on pull requests at 393 and 1440 px.
  - Playwright runs the reference apps on WebKit with the iPhone 15 profile and on Chromium desktop, including the zero-script check for a static Astro page.
  - The clean install check builds the reference apps from packed tarballs with no workspace links.
  - Size checks and Lighthouse CI fail the build when a §9 budget is exceeded.
  - The PR reports Chromatic snapshot use against the plan quota (§18.5).

### Phase 1: Brand and style guide

**Goal:** an approved brand kit, first art set, medal and emblem set, and the token-based style guide.
**Exit criteria:** a person approved the brand kit, art set and medals, and the style guide pages render from tokens with the contrast check passing.

#### P1.1 Brand kit: logo, palette, type and icon style (M)

- **Blocked by:** P0.3, P0.4
- **Spec:** §4.1 to §4.4, §4.6
- **Files:** `packages/art/svg/logo/`, `packages/art/cognito/`, `packages/hhh-css/src/icons/`, Storybook brand pages
- **Acceptance:**
  - The logo is a Halo 3 style energy sword with the HH.H wordmark, as SVG in the §4.1 variants and platform sizes.
  - The palette page shows every §4.2 value with contrast ratios for each text and background pair.
  - A type specimen compares Saira, Michroma and the system body font, and a person picks the display face.
  - The admin hosted login assets exist in `packages/art/cognito/`.
  - The icon style page shows a starter set of original icons in `@hhh/css`.
  - A person approved the kit in Chromatic.

#### P1.2 Medal and emblem set (M)

- **Blocked by:** P1.1
- **Spec:** §4.5, §9.2, §16.1
- **Files:** `packages/hhh-css/src/medals/`, `packages/hhh-css/src/emblems/`, `packages/hhh-css/art-manifest.json`
- **Acceptance:**
  - Medals cover multi-kill, spree, objective and placement achievements in original shapes, with no one-to-one copies of game medals.
  - Emblems combine an original foreground and background shape with two colors.
  - Each SVG passes the SVG lint, reads at 24 px, and stays within 4 KB gzip.
  - A person approved the set from a Storybook contact sheet.

#### P1.3 Style guide and tokens (M)

- **Blocked by:** P0.4, P1.1
- **Spec:** §4.2 to §4.4, §5
- **Files:** `packages/hhh-css/tokens/`, `packages/hhh-css/src/base.scss`, `packages/hhh-css/src/_mixins.scss`, `packages/hhh-css/scripts/build-tokens.mjs`, `packages/hhh-css/scripts/check-contrast.mjs`
- **Provides:** token names and tiers
- **Acceptance:**
  - Tokens cover every §5.2 group in primitive, semantic and component tiers.
  - The contrast check fails when a semantic text and background pair breaks the §4.2 rule.
  - Stylelint rejects literal colors, sizes, spacing and `z-index` in component styles.
  - Display font files are Latin subsets with fallback metrics, within the §9.1 font budget.
  - Storybook pages render each token group, the typography roles and the motion rules.

#### P1.4 First approved art set (M)

- **Blocked by:** P0.3, P1.1
- **Spec:** §4.5, §6.1, §10.1, §14
- **Files:** `packages/art/masters/`, `packages/art/manifest.json`, `packages/art/scripts/build-art.mjs`, `packages/art/scripts/check-art.mjs`
- **Acceptance:**
  - A person approved the helmet hero, at least one ring environment, and the first, second and third place podium figures, each with mobile and desktop crops.
  - Every master has a manifest entry with generation and approval, and the art check passes.
  - The art build produces AVIF and WebP derivatives and placeholders.
  - No official logos, fonts or screenshots are committed.

### Phase 2: Mockups

**Goal:** approved high-fidelity mockups of both apps' key screens.
**Exit criteria:** every screen in §7.2 has an approved Chromatic baseline at both viewports.

#### P2.1 Player key screens (M)

- **Blocked by:** P1.3, P1.4
- **Spec:** §6.2, §7.2, §8.1, §9.3
- **Files:** player app `mockups/` stories
- **Acceptance:**
  - Screens: sign-in with Google, Microsoft and Apple, home, service record, match postgame, and leaderboard with podium.
  - Each screen covers loading, empty and error states.
  - The review packet lists findings and fixes, and a person approved each screen in Chromatic.

#### P2.2 Admin key screens (M)

- **Blocked by:** P1.3
- **Spec:** §6.2, §7.2, §8.2, §9.3
- **Files:** admin app `mockups/` stories
- **Acceptance:**
  - Screens: match upload, match list, review queue with the evidence viewer, and roster. Admin sign-in stays on the Cognito hosted page and is not mocked up.
  - Each screen covers loading, empty and error states.
  - The review packet lists findings and fixes, and a person approved each screen in Chromatic.

### Phase 3: Components

**Goal:** the design system tier of §7.1.
**Exit criteria:** every component in §7.1 meets §20.3 and matches the approved mockups.

#### P3.1 Typography (M)

- **Blocked by:** P2.1, P2.2
- **Spec:** §4.3, §7.1
- **Acceptance:**
  - `Heading`, `Text`, `Eyebrow`, `StatValue`, `Gamertag` and `VisuallyHidden` are static-safe.
  - Stat values use tabular figures, and gamertags never break a layout at 320 px wide.

#### P3.2 Buttons (M)

- **Blocked by:** P3.1
- **Spec:** §4.4, §7.1
- **Acceptance:**
  - Every §7.1 button variant has default, hover, pressed, focus, disabled and loading states.
  - The primary style uses the amber selection treatment from §4.4.

#### P3.3 Layout and navigation (M)

- **Blocked by:** P3.2
- **Spec:** §5.2, §5.3, §7.1
- **Acceptance:**
  - The shell uses a bottom tab bar on phones and a side rail on desktop, and respects safe areas.
  - Layout primitives respond to container size.

#### P3.4 Form fields (M)

- **Blocked by:** P3.2
- **Spec:** §5.3, §7.1, §9.3
- **Acceptance:**
  - `Field`, `TextInput`, `PasswordInput`, `Select`, `Combobox`, `Checkbox`, `Radio`, `Switch` and `DateInput` exist.
  - Inputs use at least 16 px text, and validation messages are announced to screen readers.

#### P3.5 Player sign-in components (M)

- **Blocked by:** P3.3, P1.4, P2.1
- **Spec:** §8.1, §9.1, §14
- **Provides:** `SsoButton` props
- **Acceptance:**
  - `AuthLayout` loads the approved art as layered AVIF with a portrait mobile crop, within the hero image budget, with CSS-only motion that stops under reduced motion.
  - `SsoButton` supports Google, Microsoft and Apple and follows each provider's branding.
  - There are no username, password or email fields, and the Game Content Usage Rules notice shows in the footer.

#### P3.6 Overlays (M)

- **Blocked by:** P3.2
- **Spec:** §4.4, §7.1, §9.3
- **Acceptance:**
  - The bottom sheet is the default overlay on phones, and nothing is reachable only through a tooltip.
  - Focus is trapped and restored, and Escape and back gestures close overlays.

#### P3.7 Data display (M)

- **Blocked by:** P3.1
- **Spec:** §4.2, §7.1
- **Acceptance:**
  - Team rows use the team tokens and always carry a team label.
  - Wide tables keep the first column sticky and show a scroll cue on phones; `DataList` switches between cards and table by container width.

#### P3.8 Feedback and status (M)

- **Blocked by:** P3.1, P1.4
- **Spec:** §7.1, §9.3
- **Acceptance:**
  - Status badges carry text, not color alone.
  - Skeletons match the layout of the content they replace, with no layout shift.
  - `Icon` renders any `@hhh/css` icon with an accessible name or as decorative, and `ArtImage` renders caller-supplied AVIF and WebP sources with a placeholder and no layout shift.

#### P3.9 Upload and OTP fields (S)

- **Blocked by:** P3.4
- **Spec:** §7.1
- **Acceptance:**
  - `UploadField` selects several images from an iPhone photo library and shows per-file progress and retry.
  - `OtpField` wraps Base UI's OTP field with the §4.3 stat type.

#### P3.10 Publish the design system packages to npm (S)

- **Blocked by:** P0.5, P3.1
- **Spec:** §1, §13.1, §13.3, §14, §16.2, §18.10, §18.12
- **Files:** the publish workflow, release-please configuration, `packages/hhh-css/README.md`, `packages/hhh-react/README.md`
- **Acceptance:**
  - A release-please release of `@hhh/css` or `@hhh/react` on `main` runs the publish workflow, which builds, runs the published-files check, and publishes with npm trusted publishing and provenance, using no stored token.
  - `@hhh/css` publishes before `@hhh/react` when both change.
  - The workflow has only `id-token: write` and `contents: read`, and does not run on pull requests or forks.
  - Both READMEs explain installation, the CSS-only and React usage, the rendering classes, the non-affiliation statement, and the MIT license.
  - `npm install @hhh/css @hhh/react` works in an empty directory with no registry configuration.

### Phase 4: Backlog (not filed with v1)

| ID | Slice | Size | Note |
| --- | --- | --- | --- |
| P4.1 | Chart components beyond sparkline and bar | M | Waits for a screen that needs them |
| P4.2 | Search and filter chips | S | Waits for the player search screen |
| P4.3 | Real-user Core Web Vitals reporting | S | Field data for §18.4 |
| P4.4 | Light theme | M | Only if a use appears; semantic tokens make it a value swap |
| P4.5 | Real-device test service for iOS | S | Replaces the manual iPhone check if it becomes a bottleneck |

### 20.4 Dependency order and parallel lanes

The critical path is P0.1 -> P0.3 -> P1.1 -> P1.4 -> P2.1 -> P3.1 -> P3.2 -> P3.3 -> P3.5. P0.2 runs beside P0.1, and P0.4 and P0.5 run beside P0.3. P1.2 and P1.3 run beside P1.4. After P3.2, layout, forms and overlays can run in parallel, and P3.7, P3.8 and P3.10 can start after P3.1. P3.10 publishes 0.x versions as soon as the first components exist, so outside use can start before phase 3 ends. The first real product feedback is the approved player mockups at the end of P2.1.
