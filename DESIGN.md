---
name: Yori Admin
description: Curator console for a multilingual Japanese dictionary
colors:
  paper-cream: "#f7f4ef"
  warm-white: "#fdfcf9"
  parchment: "#ede9e1"
  ink: "#373228"
  ash: "#6e6555"
  stone: "#8f8677"
  marigold: "#a07520"
  marigold-deep: "#8c6510"
  marigold-wash: "#f0e8d4"
  moss: "#4d7a4d"
  moss-wash: "#e8f2e8"
  ochre: "#8a7a30"
  ochre-wash: "#f2efd8"
  terracotta: "#9a4a30"
  terracotta-wash: "#f2e8e4"
  rule: "#ddd8cf"
  rule-strong: "#c2bab0"
  code-surface: "#2c2921"
  sidebar-surface: "#373228"
typography:
  display:
    fontFamily: "Fraunces, Noto Serif JP, Noto Serif KR, serif"
    fontSize: "clamp(2rem, 1.5rem + 1.2vw, 2.5rem)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "Fraunces, Noto Serif JP, Noto Serif KR, serif"
    fontSize: "clamp(1.5rem, 1.2rem + 0.8vw, 1.875rem)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Fraunces, Noto Serif JP, Noto Serif KR, serif"
    fontSize: "clamp(1.125rem, 1rem + 0.4vw, 1.25rem)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Source Sans 3, Noto Sans JP, Noto Sans KR, Noto Sans SC, Noto Sans TC, system-ui, sans-serif"
    fontSize: "clamp(0.9375rem, 0.9rem + 0.2vw, 1rem)"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Source Sans 3, Noto Sans JP, system-ui, sans-serif"
    fontSize: "clamp(0.6875rem, 0.65rem + 0.15vw, 0.75rem)"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.06em"
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
  4xl: "64px"
components:
  button-primary:
    backgroundColor: "{colors.marigold}"
    textColor: "{colors.warm-white}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.marigold-deep}"
    textColor: "{colors.warm-white}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ash}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-secondary-hover:
    backgroundColor: "{colors.parchment}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  input-default:
    backgroundColor: "{colors.warm-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  badge-positive:
    backgroundColor: "{colors.moss-wash}"
    textColor: "{colors.moss}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  badge-caution:
    backgroundColor: "{colors.ochre-wash}"
    textColor: "{colors.ochre}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  badge-negative:
    backgroundColor: "{colors.terracotta-wash}"
    textColor: "{colors.terracotta}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  chip-filter:
    backgroundColor: "{colors.warm-white}"
    textColor: "{colors.ash}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
  chip-filter-active:
    backgroundColor: "{colors.marigold-wash}"
    textColor: "{colors.marigold}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "#b3aa98"
    padding: "12px 24px"
  nav-item-active:
    backgroundColor: "#3d3830"
    textColor: "{colors.warm-white}"
    padding: "12px 24px"
---

# Design System: Yori Admin

## 1. Overview

**Creative North Star: "The Proof Sheet"**

Like a typesetter's proof: precise, structured, type-forward. Every element is set with the same care a compositor gives to a page of reference text. The medium is the message; the typography *is* the interface.

Yori Admin is the working console for a multilingual Japanese dictionary. It serves a single curator doing operational work: reviewing AI translations, shipping releases, inspecting entries. The aesthetic is editorial meets tech: the typographic sophistication and information hierarchy of quality publishing, applied with the interaction speed of a modern tool. It is not retro or nostalgic. It is contemporary editorial precision.

The system uses a warm neutral palette anchored to OKLCH hue 45 (paper-cream, ink, stone). One accent color, marigold, marks the single most important action on each screen. Surfaces are flat at rest. Depth appears only through tonal layering and subtle border shifts on interaction. The serif display face (Fraunces) paired with a humanist sans body (Source Sans 3) signals that this is not a generic dashboard; the mixed pairing is the most visible brand marker.

**Key Characteristics:**
- Serif + sans pairing as primary brand signal
- Warm OKLCH neutrals tinted to hue 45; no pure black, no pure white
- Single marigold accent used with restraint
- Flat surfaces, no shadows; depth from tonal shifts and hairline rules
- Information density that adapts to the task at hand
- CJK-ready typography with dedicated font stacks

## 2. Colors: The Warm Ink Palette

A palette built from the materials of print: cream paper, dark ink, stone margins, and one pot of marigold for the compositor's annotations.

### Primary

- **Marigold** (`oklch(52% 0.16 45)` / `#a07520`): The sole accent. Used for primary buttons, active navigation markers, definition numbers, focused input rings, and links. Its rarity is the point.
- **Marigold Deep** (`oklch(46% 0.17 45)` / `#8c6510`): Hover and pressed state for marigold elements.
- **Marigold Wash** (`oklch(93% 0.035 45)` / `#f0e8d4`): Tinted background for active filter chips and subtle accent surfaces.

### Neutral

- **Paper Cream** (`oklch(97% 0.008 45)` / `#f7f4ef`): Primary page background. The default surface.
- **Warm White** (`oklch(99% 0.005 45)` / `#fdfcf9`): Elevated surface for inputs, cards, code containers.
- **Parchment** (`oklch(94.5% 0.012 45)` / `#ede9e1`): Secondary surface, hover backgrounds, alternating rows.
- **Ink** (`oklch(22% 0.02 45)` / `#373228`): Primary text color and sidebar surface. Warm, never pure black.
- **Ash** (`oklch(45% 0.03 45)` / `#6e6555`): Secondary text, form labels, muted interactive elements.
- **Stone** (`oklch(58% 0.025 45)` / `#8f8677`): Tertiary text, timestamps, metadata, eyebrow labels.
- **Rule** (`oklch(88% 0.012 45)` / `#ddd8cf`): Default borders, hairline dividers.
- **Rule Strong** (`oklch(78% 0.018 45)` / `#c2bab0`): Emphasized borders, table header underlines.

### Tertiary (Semantic)

- **Moss** (`oklch(45% 0.12 155)` / `#4d7a4d`): Positive states (approved, active, succeeded). On moss-wash backgrounds.
- **Ochre** (`oklch(52% 0.12 85)` / `#8a7a30`): Caution states (pending, running). On ochre-wash backgrounds.
- **Terracotta** (`oklch(48% 0.14 25)` / `#9a4a30`): Negative states (failed, rejected). On terracotta-wash backgrounds.

### Named Rules

**The Single Pot Rule.** Marigold is the only chromatic accent outside semantic status colors. If a screen has more than one marigold-highlighted element competing for attention, one of them is wrong. Reduce until only the primary action remains.

**The Tinted Neutral Rule.** Every neutral is tinted toward hue 45. Pure `#000` and pure `#fff` are forbidden. Even code surfaces and sidebar backgrounds carry the warmth.

## 3. Typography

**Display Font:** Fraunces (variable; optical size 9-144, weights 300/400/700) with Noto Serif JP/KR fallback
**Body Font:** Source Sans 3 (weights 300/400/600) with Noto Sans JP/KR/SC/TC fallback
**Mono Font:** JetBrains Mono (weights 400/500)
**CJK Font:** Noto Sans JP, Noto Sans SC, Noto Sans TC, Noto Sans KR

**Character:** The Fraunces + Source Sans 3 pairing is the system's strongest brand signal. Fraunces brings editorial weight and optical-size expressiveness; Source Sans 3 provides clean, readable body text. The contrast between the two creates hierarchy without decoration. When they appear together on a screen, the interface reads as authored, not assembled.

### Hierarchy

- **Display** (Fraunces 700, `clamp(2rem, 1.5rem + 1.2vw, 2.5rem)`, line-height 1.2, tracking -0.015em): Page titles, the login headword. The largest typographic element on any screen.
- **Headline** (Fraunces 700, `clamp(1.5rem, 1.2rem + 0.8vw, 1.875rem)`, line-height 1.2, tracking -0.02em): Section headings, metric values. Carries weight without competing with Display.
- **Title** (Fraunces 700, `clamp(1.125rem, 1rem + 0.4vw, 1.25rem)`, line-height 1.2, tracking -0.015em): Sub-section headers, card titles.
- **Body** (Source Sans 3, 400, `clamp(0.9375rem, 0.9rem + 0.2vw, 1rem)`, line-height 1.55): Running text, table cells, form values. Cap line length at 65ch in reading contexts.
- **Label** (Source Sans 3, 600, `clamp(0.6875rem, 0.65rem + 0.15vw, 0.75rem)`, line-height 1.4, tracking 0.06em, uppercase): Form labels, eyebrows, metadata, badge text. The workhorse of the system's information density.

### Named Rules

**The Proof Reader's Rule.** Fraunces is for headings and display elements only. Body text, labels, and interactive elements use Source Sans 3. Mixing display type into body contexts dilutes the hierarchy.

**The CJK Parity Rule.** Japanese, Korean, and Chinese text must use the dedicated Noto Sans stacks and remain legible at body sizes. Never fall back to the serif stack for CJK body text; CJK serif faces at small sizes are unreadable on screen.

## 4. Elevation

This system is flat. Surfaces are distinguished by tonal layering (cream, parchment, warm-white, ink) and hairline rules, never by shadows. The only depth cue is the focus ring: a 3px marigold outline at 10% opacity (`0 0 0 3px oklch(52% 0.16 45 / 10%)`) that appears on focused inputs and interactive elements.

The sidebar (ink-dark surface) sits tonally apart from the content area (paper-cream), creating a natural two-panel depth without any shadow or elevation.

### Named Rules

**The No Shadow Rule.** No `box-shadow` for ambient depth, card elevation, or surface layering. The only permitted shadow is the focus ring on interactive elements. If a surface needs to feel "above" another, shift its background lightness.

## 5. Components

### Buttons

Subtle and tactile. Small radius, gentle color transitions, clear state feedback.

- **Shape:** Gently squared corners (4px radius)
- **Primary:** Marigold background, warm-white text, Source Sans 3 at label size (600 weight). Padding 8px 16px. The only element on the page with a saturated background.
- **Hover:** Background deepens to Marigold Deep. 120ms transition.
- **Focus:** Marigold focus ring (3px, 10% opacity).
- **Secondary:** Transparent background, ash text, 1px rule border. On hover, parchment background and ink text. Border shifts to rule-strong.
- **Small variant:** Label-size text (xs), tighter padding (4px 12px).

### Badges

Status indicators with a dot + text pattern. Semantic color on a tinted wash background.

- **Style:** Small radius (4px), label-size uppercase text (600 weight, 0.04em tracking). 6px circular dot preceding the label.
- **Positive (approved, active, succeeded):** Moss on moss-wash.
- **Caution (pending, running):** Ochre on ochre-wash.
- **Negative (failed, rejected):** Terracotta on terracotta-wash.
- **Informational (promoted, ai):** Marigold on marigold-wash (uses the info token, which shares hue 45).
- **Inactive:** Stone text on parchment. The default for unclassified states.

### Chips

Pill-shaped filter controls for queue and list views.

- **Default:** Warm-white background, ash text, 1px rule border, full-pill radius (999px). Label-size uppercase text.
- **Active:** Marigold-wash background, marigold text, tinted border. `aria-current="page"` drives the state.

### Inputs

- **Style:** Warm-white background, 1px rule border, small radius (4px). Source Sans 3 at body-sm size.
- **Focus:** Border shifts to marigold. 3px focus ring at 10% opacity. 150ms transition.
- **Large variant (entry search):** Noto Sans JP at title size, increased padding. Optimized for Japanese input.
- **Textarea:** Mono font (JetBrains Mono), vertical resize only. For raw data and JSON editing.

### Navigation (Sidebar)

- **Structure:** Dark ink surface (220px fixed width), sticky full-height. Brand name in Fraunces display at headline size.
- **Items:** Source Sans 3, body-sm size, 400 weight. Muted warm tone at rest.
- **Hover:** Text brightens to warm-white, background shifts to slightly lighter ink.
- **Active (`aria-current="page"`):** Warm-white text, 600 weight, lighter ink background, 3px marigold left border marker. The sidebar's only use of accent color.

### Tables

The primary data display pattern for lists, updates, and release views.

- **Headers:** Label-style uppercase, 2px rule-strong bottom border.
- **Cells:** Body-sm text, 1px rule bottom border, left-aligned, baseline-aligned.
- **Hover:** Row background shifts to parchment.
- **Active row:** Moss-wash background for selected/active items.

### Dictionary Entry (Signature Component)

The entry inspector is the system's signature view, combining CJK display typography with structured reference-book conventions.

- **Headword:** Noto Sans JP at display size (700 weight). The largest element on the page.
- **Reading:** Noto Sans JP at title size, secondary text color. Positioned beside the headword.
- **Sections:** Separated by hairline rules, each with a label-style uppercase header (Source Sans 3, stone color).
- **Definitions:** Ordered list with left padding. Body-size text.
- **Part-of-speech tags:** Label-size uppercase in rule-bordered chips (4px radius).

## 6. Do's and Don'ts

### Do:

- **Do** use Fraunces for headings and display elements only; keep body text and UI chrome in Source Sans 3.
- **Do** use OKLCH for all color definitions, with hue 45 as the shared warmth anchor.
- **Do** vary information density by context: dense for review queues, spacious for login and single-entry views.
- **Do** use hairline rules and tonal shifts to create visual separation between sections.
- **Do** test all screens with mixed Japanese-English content at body sizes.
- **Do** use the focus ring (3px marigold at 10% opacity) on every interactive element.

### Don't:

- **Don't** use AI/dark-mode tech aesthetic: no cyan-on-dark, neon accents, purple gradients, glassmorphism, or glow effects.
- **Don't** add decorative Japanese theming: no kanji watermarks on operational screens, no ornamental borders, no shrine-gate motifs, no cherry blossom backgrounds.
- **Don't** write wordy, hand-holding copy: no long help text under every field, no intro paragraphs that restate the heading.
- **Don't** style anything to read as "AI startup" or generic "developer tool."
- **Don't** use `box-shadow` for surface elevation. The only shadow is the focus ring.
- **Don't** use pure `#000` or `#fff`. Every neutral carries hue-45 warmth.
- **Don't** use `border-left` or `border-right` greater than 1px as a colored accent stripe (except the sidebar's active nav marker, which is a structural affordance, not decoration).
- **Don't** highlight more than one element per screen with marigold. If everything is accented, nothing is.
- **Don't** use gradient text (`background-clip: text`).
- **Don't** use card grids where every card is the same size with icon + heading + text repeated.
