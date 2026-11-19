# QA-Core dashboard design system

One calm, consistent system on every page, for CTOs, QA managers and CEOs. Locked by `scripts/smoke-design-system.ts` and CLAUDE.md invariants 68 and 86. The few layout rules the look depends on are in the Layout section at the end.

## Type scale

Exactly seven sizes, defined as the whole `theme.fontSize` in `dashboard/tailwind.config.ts` (Tailwind's defaults do not exist). Nothing on screen is below 12px, chart SVG text included.

| Name | Size / line height | Letter spacing | Class |
|---|---|---|---|
| display | 32 / 40 | -0.02em | `text-display` |
| title | 24 / 32 | -0.02em | `text-title` |
| heading | 18 / 26 | -0.01em | `text-heading` |
| subheading | 16 / 24 | 0 | `text-subheading` |
| body | 14 / 22 | 0 | `text-body` |
| small | 13 / 20 | 0 | `text-small` |
| caption | 12 / 16 | 0 | `text-caption` |

Weights: 400 (`font-normal`), 500 (`font-medium`), 600 (`font-semibold`) only. No bold, extrabold, light or `<b>`.

Families: Inter for all UI text and numbers (tabular figures on, `.money`); Geist Mono only for run ids, commands and code, at 13px (`.mono`). Both are bundled (`@fontsource-variable/inter`, `@fontsource-variable/geist-mono`), never loaded from a CDN. Inter replaced Plus Jakarta Sans in November 2026: a neutral face with every weight the scale uses, easier to read in dense tables. A stage tab's stat line is UI text, not code, so it is Inter.

The seven names are registered with tailwind-merge in `dashboard/src/lib/utils.ts`, so a size class never knocks out a colour class.

## Role map

Applied by role, never by find-and-replace of class names.

| Role | Size | Weight | Colour |
|---|---|---|---|
| Page headline sentence (Projects) | display | 600 | fg |
| Page title (h1 on every other page, the project name) | title | 600 | fg |
| A project card's "tests ready" number | display | 600, tabular | fg |
| Key metric number (tiles, the run hero) | title | 600, tabular | fg (violet only for a findings count) |
| Section heading (h2, stage panels, collapsible sections) | heading | 600 | fg |
| Card title, dialog title, findings section title | subheading | 600 | fg |
| Body text, table cells, nav items, buttons, inputs | body | 400 text; 500 nav, buttons, a table's first column | fg |
| Secondary text (URLs, helper text, timestamps, tooltips) | small | 400 | fg-2 |
| Labels, table headers, badges, pills, chart axes, stage status | caption | 500 | fg-2 labels; fg-3 table headers, sentence case |
| Eyebrow (the one uppercase label, Projects) | caption | 500 | brand |

Text colours are fg, fg-2 and fg-3 only. Status colours (pass, rework, reject, finding, neutral) appear only where they mean a status: a verdict, a run status, a finding, a stage status. Brand is for the primary action, the active nav item and links. One filled primary button per view of page content (the sidebar's "Run a test" is the frame's primary and reads as the active destination on its own page). On a run page the primary is "Download framework"; on a run that stopped early it is Resume, and the download steps back to outline. Money is plain text, never a colour: the cost token only fills the cost-split bar.

## Spacing, radius, sizes

- 4px grid. Spacing steps 1, 2, 3, 4, 5, 6, 8, 10, 12, 16 only: no half steps (1.5, 2.5) and no arbitrary values for padding, margin, gap, text, tracking or leading. Layout widths (a sidebar width, a grid template, a column percentage) may stay arbitrary.
- Page padding 32 (16 at 390). Card padding 24. Gap between sections 32.
- Radius: lg 12 (cards), md 8 (buttons, inputs; also the default `rounded`), sm 6 (badges), full for pills. No xl.
- Buttons 36px tall (32 for small). Inputs 36. Table header row 36, body rows at least 44 (12px padding over a 20px line). Numbers right-aligned in tables. Row hover bg-2, no zebra.
- Icons 16 in body, 14 in caption, 20 in page headers (`h-4`, `h-3.5`, `h-5`).
- Shadows only on hover (`card-lift`) and popovers (`shadow-lift`).

## Formatter rules (`dashboard/src/lib/format.ts`)

The one formatter module. It formats the values the server sent and never computes one (standing rule 3). A missing value reads "n/a", never 0 or $0.00 (standing rule 2).

- `formatMoney(v)`: "n/a" for null, undefined or NaN; "<$0.01" above 0 and below 0.005; otherwise 2 decimals ("$6.69"), everywhere, the run hero and the stage view included. The exact value goes in a tooltip through `exactMoney(v)`, which reads "not recorded" for a missing value.
- `formatDate(iso)`: fixed en-GB locale, never the browser's: "5 Oct", "5 Oct 2025" in another year, "Today, 14:05" for today, 24-hour. Missing or invalid reads "n/a". `formatDateTime(iso)` gives the full date and time for a tooltip; `formatTime(iso)` a time of day for an event row.
- `formatCount(n, singular, plural)`: "1 test", "12 tests"; null reads "n/a". Every count on screen goes through it (this is what fixed "1 tests shipped").
- `pct(v)` and `duration(start, end)` as before, except that a missing value reads "n/a". `formatSize(bytes)` for file sizes.
- No `toLocale*` call outside this module.

## Copy that is part of the system

- A last run that is not completed shows the pill "Stopped early" (or "Empty run", "Run failed"); the pill's tooltip carries the full LABEL text ("Last run stopped, checkpoint kept").
- Table headers are sentence case; the only uppercase text is the Projects eyebrow.

## Layout

- One content width on every page: `max-w-content`, 1600px, centred. The left edge never moves between pages.
- Projects: at most four cards in a row, each at least 284px wide, so four fit on a 14 inch laptop at 100% zoom (1512px); fewer cards keep their card width and are never stretched across the row. Under the cards, "Recent runs" lists the five newest runs that have a report, in the Runs page's own table, with an "All runs" link.
- Runs table: the run's name leads the row and its status sits beside the numbers.
- Run page (invariant 86): one header line (started, ended, total cost, source, site), then the six stages as a tab list. One stage's panel is on screen at a time. A finished run opens on Summary, where the three numbers and the one download share the first screen; a live run follows the stage that is running until a person picks a tab. Long Critic notes show two lines in the scenarios table with the whole text in the tooltip.
- Dark theme: a card surface (bg-1) is clearly lighter than the page (bg-0), so cards read as cards without a shadow.
- No page scrolls sideways at 390, 1280, 1440, 1580 or 1976. A wide table scrolls inside its own box.

## Specimen

`docs/ui/design-system/specimen-light.png` and `specimen-dark.png` show every size and role in both themes, rendered from the built app's own CSS. `docs/ui/best-version/` holds the Projects page and a run page in both themes at 1580 wide, rendered from real run folders.
