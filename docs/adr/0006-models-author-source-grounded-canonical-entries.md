# Models author source-grounded canonical entries

Directly translating one source gloss at a time preserves the source's awkward wording and sense boundaries. It also prevents Yori Dict from filling legitimate meanings missed by that source. Generating from the headword alone has the opposite failure: tests on `情報`, `動画`, `適当`, `結構`, `大丈夫`, `生`, `忖度`, and `やばい` frequently omitted uncommon, grammatical, or technical senses.

Yori Dict therefore uses source-grounded authoring. Licensed sources are combined into source evidence and establish minimum coverage. The model authors a canonical entry rather than translating that evidence mechanically. It may split an overloaded source sense, merge truly equivalent evidence, or add an established missing sense from lexical knowledge.

One output sense represents one distinguishable usage. Senses with different parts of speech, registers, domains, or pragmatic functions are not merged merely because their translations overlap. Every source-backed sense retains its evidence ids. A sense added from model knowledge is explicitly recorded as generated.

Imported source records are immutable inputs. Regeneration can replace Yori's canonical generated layer, but never silently overwrites what a source said.

## Consequences

Review measures coverage, factual and lexical accuracy, sense structure, labels and pronunciation, natural target-language wording, and unsupported content. Literal agreement with one English gloss is not the goal.

Source labels are normalized deterministically where possible. Models do not invent labels for a source-backed sense merely to make an entry look richer.

The refined source-grounded prompt was the strongest tested approach, but tests remain regression evidence rather than a claim that every generated entry is correct. Any reviewer-reported material problem rejects the candidate.
