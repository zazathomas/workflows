---
version: beta
name: Argo Workflows UI
description: Design language for the web console of workflows, an opinionated Argo Workflows server-and-UI fork for submitting and monitoring Kubernetes workflow jobs.
colors:
  # Theme roles. Values are the dark theme, which is the default; the light
  # values are in the theme table below.
  canvas: "#111827"
  surface: "#1f2937"
  surface-sunken: "#273548"
  surface-hover: "#263549"
  surface-selected: "#164e63"
  text-strong: "#f8fafc"
  text-primary: "#e5edf5"
  text-secondary: "#c6d5e3"
  text-muted: "#a8b8ca"
  border: "#334155"
  border-strong: "#475569"
  accent: "#9fe8ef"
  accent-strong: "#006f8a"
  accent-soft: "#164e63"
  focus-ring: "#22d3ee"
  # Status: a tinted pair for text and chips, plus a solid mark for graphs,
  # timelines and charts.
  status-running-text: "#67e8f9"
  status-running-soft: "#164e63"
  status-succeeded-text: "#6ee7b7"
  status-succeeded-soft: "#0d3d31"
  status-failed-text: "#fda4af"
  status-failed-soft: "#4a1f26"
  status-pending-text: "#fcd34d"
  status-pending-soft: "#46350d"
  status-neutral-text: "#c4c0d8"
  status-neutral-soft: "#2f2b3d"
  status-running-mark: "#0dadea"
  status-succeeded-mark: "#18be94"
  status-failed-mark: "#e96d76"
  status-pending-mark: "#f4c030"
  status-neutral-mark: "#766f94"
typography:
  body:
    fontFamily: "Heebo, Helvetica Neue, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 400
  scale: "11px, 12px, 13px, 14px, 16px, 20px, 26px"
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  pill: 999px
components:
  button-primary:
    backgroundColor: "{colors.accent-strong}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
  button-primary-hover:
    backgroundColor: "#0a7f99"
    textColor: "#ffffff"
  button-outline:
    backgroundColor: transparent
    textColor: "{colors.accent}"
    border: "1px solid {colors.border-strong}"
    rounded: "{rounded.pill}"
  card:
    backgroundColor: "{colors.surface}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.lg}"
  list-row:
    backgroundColor: "{colors.surface}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.lg}"
    textColor: "{colors.text-primary}"
  list-row-hover:
    backgroundColor: "{colors.surface-hover}"
  chip-status:
    backgroundColor: "{colors.status-succeeded-soft}"
    textColor: "{colors.status-succeeded-text}"
    rounded: "{rounded.pill}"
  field:
    backgroundColor: "{colors.surface}"
    border: "1px solid {colors.border-strong}"
    rounded: "{rounded.md}"
  nav-active-item:
    backgroundColor: "{colors.surface-selected}"
    textColor: "{colors.accent}"
    rounded: "{rounded.md}"
---

# Argo Workflows UI

## Overview

The web console for **workflows**, an opinionated Argo Workflows server-and-UI fork: a React application embedded in `argo server` for submitting, running, and monitoring Kubernetes workflow jobs. The interface uses job-runner terminology — reusable definitions are **Jobs**, executions are **Runs**, time-based definitions are **Schedules** — alongside events, reports, approvals, and runners.

The design direction is a dark-first operational console: a neutral chrome, one accent family for interaction, phase colours that carry status meaning across every view, sentence-case interface copy, and a fixed navigation rail grouping the product areas. Content sits in flat bordered cards rather than floating white boxes. Both themes are complete and equally maintained; dark is the default.

## Design tokens

Every colour, radius, shadow, type size, space step and duration in the UI is a CSS custom property declared in `ui/src/shared/theme-tokens.scss`. That file is the only place a colour may be written. A component stylesheet reads `var(--…)` and holds layout only.

The token file also owns the element layer: the overrides for argo-ui's `.white-box`, `.argo-table-list`, `.argo-button`, `.argo-field` and popup surfaces live there, so a new page inherits the design language without restating it. Adding a colour, radius or shadow literal to a component stylesheet is a regression, as is reintroducing a `.theme-dark` block: theming happens through tokens, never by duplicating rules.

## Themes

Dark is the default. The choice persists under `argo-ui-theme` in localStorage and otherwise follows `prefers-color-scheme: light`. `ModernLayout` puts `theme-light`/`theme-dark` on the layout root and `modern-theme-dark` on `<body>`; the token file declares values on both, so portals that render outside the layout root (popups, dropdowns, date pickers) resolve the same palette. The sign-in page renders outside the shell and carries `login--light`/`login--dark`, which are included in the same token blocks.

| Role | Light | Dark (default, in frontmatter) |
| --- | --- | --- |
| canvas | #f4f7f9 | #111827 |
| surface | #ffffff | #1f2937 |
| surface-sunken | #edf4f7 | #273548 |
| surface-hover | #e7f4f7 | #263549 |
| surface-selected | #d8f1f5 | #164e63 |
| text-strong | #172033 | #f8fafc |
| text-primary | #263442 | #e5edf5 |
| text-secondary | #526575 | #c6d5e3 |
| text-muted | #607086 | #a8b8ca |
| border | #dce6ec | #334155 |
| border-strong | #c7d8df | #475569 |
| accent | #006f8a | #9fe8ef |
| accent-strong | #006f8a | #006f8a |
| accent-soft | #e7f4f7 | #164e63 |
| focus-ring | #0d7d92 | #22d3ee |

## Colours

- **Surfaces.** `canvas` is the page, `surface` is a card, table row or panel, `surface-sunken` is a header strip or inset block, `surface-hover` and `surface-selected` are interaction states. Overlays use `--overlay` and `--scrim`.
- **Text.** `text-strong` for headings and values, `text-primary` for body, `text-secondary` for supporting copy, `text-muted` for metadata. Every text token clears 4.5:1 on its own surface in both themes.
- **Accent.** One teal family. `accent` for links and outline controls, `accent-strong` for filled primary buttons and selected controls, `accent-soft`/`accent-soft-text` for tinted chips and quiet buttons, `focus-ring` for the focus indicator. No other hue is used for interaction.
- **Status.** Each phase has a tinted pair (`--status-*-text`, `--status-*-soft`) for text, chips and tinted backgrounds, and a solid mark (`--status-*-mark`) for graph nodes, timeline bars and chart segments. Tinted pairs keep phase colour readable; the saturated fills in the earlier spec failed contrast at 1.7:1 to 3:1 and are no longer used behind text.
- **Machine strings.** Log output, YAML, cron expressions and keys use `--font-mono`. The log console keeps a fixed dark terminal surface (`--terminal-surface`) in both themes so the ANSI palette reads identically everywhere.

## Typography

Heebo is the working typeface; the scale has seven steps (`--text-2xs` 11px through `--text-2xl` 26px) and nothing outside it. Body copy is 13–14px at weight 400.

Sentence case is the rule for buttons, form labels, tabs, headings and body copy. Uppercase is reserved for micro-labels that structure a surface: table column heads, navigation group labels, and section eyebrows, set at 11px with 0.04–0.08em tracking.

The repository ships one weight (`ui/src/assets/fonts/Heebo-Regular.ttf`); the token layer loads it with an `@font-face` (`font-display: swap`), so the fallback stack shows only while it downloads. Weights 500–700 are synthesised by the browser. Adding the heavier cuts is the outstanding typography task.

## Layout

Every page renders inside `modern-layout`: a fixed left navigation rail that collapses to icons and expands to grouped, labeled sections, a fixed translucent top bar that shows breadcrumbs (page titles are hidden; the breadcrumb trail carries the context), and content offset by the rail. argo-ui's `Page` and `TopBar` provide the in-page skeleton. On small screens the rail becomes an overlay drawer with a scrim and the top bar reduces to breadcrumbs.

Space comes from a six-step scale (`--space-1` 4px through `--space-6` 32px).

Lists are a stack of flat bordered rows inside a transparent list, never a floating card per row. The runs table lays out thirteen columns; cells truncate with an ellipsis to fit the card at every width above 1100px, and the table itself scrolls below that.

## Shapes

Five radii: `--radius-sm` 6px for chips, tags and small controls, `--radius-md` 8px for inputs and nav items, `--radius-lg` 12px for cards, rows and popups, `--radius-xl` 16px for modal and popup shells, and `--radius-pill` for buttons, status chips and badges. Menu items inside a popup use `--radius-md`; the button's pill radius does not belong on a stacked menu.

## Elevation and motion

Three shadows: `--shadow-card` for cards and rows, `--shadow-raised` for popups, menus and floating panels, `--shadow-overlay` for modals and full-screen sheets. Depth is otherwise expressed with borders and surface steps.

Motion uses `--duration-fast` (120ms) for state changes and `--duration-base` (180ms) for layout, both with `--ease`. `prefers-reduced-motion` disables transitions and status spinners.

## Components

- **Buttons** — `argo-button`, pill-shaped, sentence case, 13px at weight 600. Two variants: `--base` (filled with `accent-strong`, white label) and `--base-o` (1px `border-strong` outline, accent label, tints to `accent-soft` on hover).
- **Cards** — `.white-box`: `surface` background, 1px `border`, `--radius-lg`, `--shadow-card`, 24px padding.
- **List rows** — `.argo-table-list__row`: `surface` background, 1px `border`, `--radius-lg`, 8px/12px padding, 1.5 line-height, hover brightens the border, selection uses `surface-selected`. The column head is an uppercase 11px micro-label in `text-secondary`.
- **Status chips** — tinted pair on a pill; the phase word is capitalised, never uppercase.
- **Fields** — boxed inputs: `surface` background, 1px `border-strong`, `--radius-md`, accent border plus focus ring when focused.
- **Focus** — one indicator: `2px solid var(--focus-ring)` at `2px` offset on `:focus-visible`, declared once in the token layer. argo-ui suppresses the browser outline with `!important`, so the token layer restores it the same way.
- **Zero states** — the shared `zero-state` component stands in for empty lists.

## Do's and Don'ts

- Do write colour, radius, shadow, type and space values as `var(--token)`.
- Do use the status tinted pair for anything that sits behind or beside text, and the solid mark for graphs and timelines.
- Do keep sentence case for buttons, labels and body copy; reserve uppercase for micro-labels.
- Do rely on the token layer's single focus ring instead of adding one per component.
- Don't add a `.theme-dark` or `.modern-theme-dark` block to a component stylesheet.
- Don't introduce a colour, radius, shadow or font size outside the token file.
- Don't set `background: #fff` on a component; use `surface` so the surface follows the theme.
- Don't use the button's pill radius for menu items.

## Known exceptions

- `ui/src/shared/models/workflows.ts` returns phase hex values from `getColorForNodePhase` for chart.js canvases, which cannot read CSS custom properties. It mirrors `--status-*-mark`.
- Help illustrations are light-background PNGs and invert in dark theme, which no colour token can express.
- The log console stays dark in both themes.
