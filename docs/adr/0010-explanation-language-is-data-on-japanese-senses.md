# Explanation language is data on Japanese senses

Japanese content used to hang every gloss language off one shared sense list. That structure claimed English, German, Taiwanese Chinese, Simplified Chinese, and Korean all divide the same word the same way, which real dictionaries do not. It also let a gloss travel without its language, so one release path could put several languages into a single Yomitan pack.

The Japanese dictionary now stores canonical content in concise `ja_*` tables, and `ja_senses` carries the explanation language. An entry shares only identity and written forms. Each explanation language owns independent sense identifiers, ordering, wording, examples, and provenance. A gloss row and an example row have no language of their own; they inherit the one their sense declares. Japanese explanations of Japanese entries need no schema change, only rows.

Imported senses keep JMdict's editorial order inside each language, and positions restart at 1 per language, so a language that covers fewer senses is not full of gaps. Legacy accepted Chinese and Korean content enters through the exact imported sense identifier it was written against and becomes that language's own sense with generated provenance. No general semantic merger and no automatic character conversion creates canonical content.

## Consequences

One entry may have different sense counts, identifiers, wording, order, and examples in different languages, and lookup returns exactly the requested language's group or nothing.

Enrichment authors one entry-language group per request, and one reviewer accepts or rejects that group. A rejection or retry in one language cannot disturb another language's accepted content for the same entry.

A release publishes one canonical SQLite and JSONL plus one Yomitan pack per explanation language, named `yori-ja-<lang>.zip`. Language separation is structural rather than a filter applied while writing, so a pack cannot silently mix languages.

Source maintenance is a deliberate full rebuild into a fresh file. A failed rebuild leaves the previous database usable, and a sense the pinned source version no longer contains simply disappears along with the legacy records mapped onto it.
