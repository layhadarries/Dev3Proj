# AI security and prompt injection

The language model is a parser, not an authority. It has no tools, secrets,
transaction signing or submission capability.

## Parsing controls

- Deterministic pre-guards reject negation, modifiers, hidden control
  characters, unsupported assets and ambiguous recipient/amount counts.
- Simple well-formed transfer syntax may be parsed without an LLM.
- For model-assisted parsing, the response is a strict discriminated union.
- Unknown JSON fields are rejected.
- Model output is grounded against exact recipient and amount values in the
  user text.
- The server builds the draft from user text, not model-supplied values.

## Compromised-model cases

Tests cover fabricated recipients, fabricated amounts, unauthorized actions,
malformed JSON, extra fields, unsupported assets and prompt-injection text.
These tests prove deterministic rejection behavior, not impossible-to-violate
model resistance.
