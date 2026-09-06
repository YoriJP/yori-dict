# Japanese coverage gaps use exact Evidence identity

Explanation Languages own independent Sense divisions. A Taiwanese dictionary may merge two source meanings into one Sense, while a Korean dictionary may split one source meaning into several. Comparing their Sense counts therefore cannot prove that either group is incomplete.

Yori Dict defines Expected Evidence as the exact source identifiers admitted by the current Japanese source policy. Covered Evidence is the union of identifiers cited by one Explanation Group. Only a non-empty `Expected Evidence − Covered Evidence` derived from reliable mappings is a Proven Coverage Gap. A group without reconstructable mappings has Unknown Coverage; it remains readable and is never automatically replaced as partial.

Japanese `ja-3` stores Sense-to-Evidence relationships separately so one Sense may cite any number of Evidence identifiers. Rebuild and production import store each proven missing identifier with its source version and derivation basis. Absence of a gap row means only “not proven partial,” never “linguistically complete.” Schema migration creates and backfills the storage but does not perform a full content audit.

Ordinary lookup remains model-free and returns available partial content. Authenticated Enrich-on-Lookup may replace a proven-partial group using complete Source Evidence reconstructed from canonical SQLite. Every Expected Evidence identifier must appear in the accepted result. Two unanimous review passes remain required in production. Replacement writes one Explanation Language, all of its Evidence relationships, and gap removal in one transaction; Entry identity and other languages are untouched.

Rejected, malformed, deterministically invalid, or provider-failed repair returns the existing group and leaves the gap retryable. Storage failure remains fatal. Accepted repairs survive rebuild and release import. Complete current imported content is authoritative; proven-partial legacy content cannot erase an accepted repair. If the source inventory grows, the repaired content stays visible and only the new missing identifiers reopen the gap.

This rejects two alternatives. Sense-count comparison would label legitimate cross-language structure as defective. Eager replacement of all legacy groups would spend model credits, discard useful content, and rewrite Unknown Coverage without objective evidence. Gap audit and release publication are deterministic and model-free; paid bulk repair remains a separate explicitly authorized operation.
