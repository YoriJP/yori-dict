# Generation and review use pinned programmatic models with conservative failure rules

Claude CLI orchestration is difficult to scale, observe, and use on demand. Yori Dict uses the official `@openrouter/sdk` behind its small `ModelGateway` port, with pinned model snapshots, reasoning effort, serving provider, and prompt version. The broader AI SDK abstraction is not used because this module needs one gateway and two fixed models, not a provider framework.

The initial tested pairing for Japanese-to-Taiwan-Chinese enrichment is GPT-5.6 Luna at minimal effort for eligibility and source-grounded generation, followed by Gemini 3 Flash Preview at minimal effort for review. The reviewer is a different model family and never rewrites a candidate. English generation uses the same module, but its final model choice remains gated on the hard-English comparison rather than assumed from the Taiwan test.

Review is deliberately asymmetric: a false rejection leaves a recoverable coverage gap, while a false acceptance pollutes public dictionary data. Any material issue in the review output rejects the candidate even if an overall boolean says it is publishable. Missing, malformed, or incomplete verdicts fail closed.

Semantic rejection, deterministic validation failure, and malformed model content are terminal for that candidate. They are not regenerated. Only transient provider, transport, timeout, rate-limit, and service-tier failures may retry.

Bulk work uses Flex for at most three total transient attempts, then records an error. On-demand work attempts Flex once and may fall back once to standard service after a transient Flex failure. Authentication, configuration, and permanent request errors never retry.

OpenRouter model fallback is disabled and required parameters must be supported. SDK retries are also disabled: the enrichment module alone owns the Flex and standard-tier retry policy.

## Examples

If a sense lacks a sourced or accepted example, Luna produces a Japanese example with English and Taiwan-Chinese translations in one structured call. Gemini reviews the sense match, naturalness, complexity, translation agreement, Taiwan terminology, and safety. Accepted Taiwan Chinese is converted to Simplified Chinese with OpenCC. An example rejection does not affect its entry.

## Observability

Every attempt records its candidate id, role, prompt version, model snapshot, reasoning effort, provider, requested and effective service tier, provider request id, duration, token use, and classified outcome. Bounded prompts, responses, and errors remain in the staging overlay for debugging; public exports remove those payloads and expose concise per-entry provenance.

No manual review queue is introduced. Regression corpora contain difficult vocabulary, Taiwan terminology, political framing, and deliberately mutated errors. Model or prompt changes must pass those evals before becoming the pinned configuration.
