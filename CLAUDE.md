# yori-dict — Project Instructions

Yori is a multilingual Japanese dictionary with an immutable-release pipeline and a server-rendered admin console (Hono + Bun + SQLite). The admin console at `/admin` is the primary interface for curators.

## Design Context

See `.impeccable.md` for the canonical version. Summary:

- **Audience**: Single curator today, 2–5 trusted collaborators soon. Technical, task-driven, value scan-and-act over hand-holding.
- **Brand personality**: Editorial. Considered. Quiet authority. The back office of a serious lexicographic project, not a generic SaaS dashboard.
- **Aesthetic**: Printed-reference-book sensibility for the screen. Fraunces + Source Sans 3 + Noto CJK. Warm neutral palette (OKLCH hue 45, paper-cream and ink). One restrained marigold accent.
- **Anti-references**: Card-grid SaaS dashboards, Material/shadcn lookalikes, AI-startup tropes (cyan-on-dark, gradients, glassmorphism, glowing borders), wordy intro paragraphs.

### Design Principles

1. **Typography is the interface.** Hierarchy from weight, optical size, and spacing — not boxes, badges, or color.
2. **Dictionary as metaphor, not theme park.** Use printed-reference conventions (numbered senses, headword + reading + POS, glosses) where they communicate something real; don't decorate.
3. **Quiet color, loud type.** Warm neutrals dominate. The accent color is reserved for the one action or state that matters most on the current screen.
4. **Asymmetric, not grid-locked.** Lay pages out around a single text column with a marginalia column for metadata. Avoid 2×2 / 3×3 card grids.
5. **One curator or five, the page reads the same.** Personal state lives in the marginalia; the work owns the center.
