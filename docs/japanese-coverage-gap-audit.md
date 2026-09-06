# Japanese coverage-gap audit

Coverage counts are observations of a particular source snapshot, not product invariants. They must not be hard-coded into rebuild or release acceptance.

The Issue #49 approval snapshot recorded these legacy-database baselines:

| Explanation language | Partial groups | Missing Evidence IDs |
| --- | ---: | ---: |
| Traditional Chinese (`zh-tw`) | 129 | 145 |
| Simplified Chinese (`zh-cn`) | 129 | 145 |
| Korean (`ko`) | 309 | 393 |

On 2026-09-06, a model-free rebuild from the repository's then-pinned JMdict source (`3.6.2`) produced:

| Explanation language | Partial groups | Missing Evidence IDs |
| --- | ---: | ---: |
| Traditional Chinese (`zh-tw`) | 129 | 145 |
| Simplified Chinese (`zh-cn`) | 129 | 145 |
| Korean (`ko`) | 271 | 348 |

The Chinese observations matched the approval snapshot. The Korean result changed because this audit rebuilt from the current source files rather than treating the older database snapshot as canonical. The exact `様` (`jmdict:1410750`) audit rows included missing Evidence IDs `jmdict:1410750:2`, `jmdict:1410750:3`, and `jmdict:1410750:4` for both Chinese explanation languages.

Two releases built from that same input were compared byte-for-byte. Their SQLite, JSONL, manifest, and Yomitan artifacts were identical. No model call or paid repair was run.
