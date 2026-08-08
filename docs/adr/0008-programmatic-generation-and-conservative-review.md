# Generation and review use pinned programmatic models with conservative failure rules

Claude CLI orchestration is difficult to scale, observe, and use on demand. Yori Dict uses the official `@openrouter/sdk` behind its small `ModelGateway` port, with pinned model snapshots, reasoning effort, serving provider, and prompt version. The broader AI SDK abstraction is not used because this module needs one gateway and two fixed models, not a provider framework.

Japanese enrichment uses GPT-5.6 Luna at minimal effort for eligibility and source-grounded generation, followed by Gemini 3 Flash Preview at minimal effort for review. English author and reviewer models remain explicit runtime configuration until a blind hard-English comparison selects them. In either dictionary, the reviewer is a different model family and never rewrites a candidate. Each dictionary keeps independent prompts, evidence, validation, and reviewer calibration.

Review is deliberately asymmetric: a false rejection leaves a recoverable coverage gap, while a false acceptance pollutes public dictionary data. The reviewer returns exactly `ACCEPT` or `REJECT`; any other output fails closed. Prompts, candidates, raw responses, and classified outcomes remain available for private diagnosis, so production does not pay for unused explanations or issue codes.

A refusal is never recorded. Semantic rejection, deterministic validation failure, and malformed model content all end the current attempt and produce no content, and the next lookup for that word starts over. Nothing about the refusal is stored, so there is no table, key, or cache to clear when a prompt or model changes.

This replaces an earlier rule that made those three outcomes terminal for the candidate. That rule could not tell a judgment about the word apart from a defect in our own code, and it wrote both permanently: a validation rule the prompt had never stated banned the word for good, and correcting the prompt did not release it. Reviewer output also varies run to run, so a single unlucky `REJECT` removed a valid word forever. The cost the old rule avoided is repeated model calls for input that always fails; with the owner's token required for any model work, a rate limit on that token is the proportionate control.

A refusal is logged as `enrichment_refused` with the stage, the headword, and the rule that refused it, including the offending value. That log line is the only record.

Only transient provider, transport, timeout, rate-limit, and service-tier failures retry within a single attempt.

Bulk work uses Flex for at most three total transient attempts, then records an error. On-demand work attempts Flex once and may fall back once to standard service after a transient Flex failure. Authentication, configuration, and permanent request errors never retry.

OpenRouter model fallback is disabled and required parameters must be supported. SDK retries are also disabled: the enrichment module alone owns the Flex and standard-tier retry policy.

## Examples

If a meaning lacks a sourced or accepted example, Luna produces one example for that meaning's own explanation language in one structured call. Gemini reviews the sense match, naturalness, complexity, translation agreement, Taiwan terminology, and safety. Simplified and Taiwanese Chinese are authored separately; no accepted content is character-converted into another language. An example rejection does not affect its entry.

## Observability

Every attempt records its candidate id, role, prompt version, model snapshot, reasoning effort, provider, requested and effective service tier, provider request id, duration, token use, and classified outcome. Bounded prompts, responses, and errors remain in the production database for debugging; public exports remove those payloads and expose concise per-entry provenance.

No manual review queue is introduced. Regression corpora contain difficult vocabulary, Taiwan terminology, political framing, and deliberately mutated errors. Model or prompt changes must pass those evals before becoming the pinned configuration.
