# Models tool

The Models tool shows which chat models workers can run and remembers the user's model preferences, so Orchestrator picks worker models the way the user wants across sessions.

## Listing models

By default the list shows only the models that matter right now: every model the user has a saved preference for, and every model an OMP role currently runs. The full catalog, which can hold hundreds of models, is available on request and can be narrowed by provider or by a search term that matches model names, roles, and the user's notes. Long lists are cut to a limit, and the result says how many matched in total.

Each entry names the exact model value to use for a worker, including a thinking level when one applies, along with its provider, supported thinking levels, context size, accepted input, price when known, the OMP roles that run it, and any saved preference.

Preferred models come first, ordered by rank and then unranked, followed by models that only an OMP role uses, then the rest, and avoided models last.

## Remembering preferences

A preference is saved for one exact model value, so the same model at two thinking levels can carry different preferences. The user can:

- prefer a model, optionally saying which roles or kinds of work it is for, how it ranks against other preferred models, and why;
- mark a model to avoid, optionally with the reason; or
- forget a saved preference.

Saving checks the model against the live catalog, so a misspelled model or an unsupported thinking level is refused instead of remembered. Saving again for the same model value replaces the earlier entry.

Preferences are personal and stay on the user's machine; they are not shared with the repository.

## Stale entries

When a saved model disappears from the catalog, or an OMP role points at a model the catalog does not have, the list reports it as an issue rather than failing. The stale preference can still be forgotten by its exact value.
