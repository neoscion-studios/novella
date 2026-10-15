# Proofreading diagnostic fixture

This diagnostic records observed behavior; it is not a detection-rate promise or an application acceptance test. The source fixture is `test/fixtures/proofreading-diagnostic.md`.

## Verified environment

- Date: 2026-10-10
- Checker: LanguageTool 6.8, the digest pinned in `compose.yaml`
- Language: `en-US`
- Input: Novella's Markdown plain-text projection, not raw Markdown
- Network/runtime: the private read-only checker configuration documented in `docs/deployment.md`

## Observed LanguageTool findings

LanguageTool 6.8 reported these rules for the fixture:

- `MORFOLOGIK_RULE_EN_US`: `Caelion` as an unknown word;
- `MORFOLOGIK_RULE_EN_US`: `teh` as a spelling mistake;
- `HE_VERB_AGR`: the verb in `She don't`;
- `BETWEEN_YOU_AND_I`: `Between you and I` (LanguageTool classifies this rule as a misspelling, but Novella does not offer a dictionary action because the match is a phrase); and
- `PLURAL_VERB_AFTER_THIS`: `this are`.

The same run did not report the deliberately planted `Caelion walk`, `the lantern are`, or `the maps was` agreement problems. That is a limitation of the current LanguageTool rules for this passage, not evidence that the text is correct. Novella does not invent findings for missed errors.

The URL, inline code, and fenced-code text were absent from the checker request. Removing those spans did not create consecutive-space findings. The automated pipeline test verifies the exact projected request, language, normalized categories, and mapped source offsets with a deterministic injected response; it does not depend on future LanguageTool rule changes.
