# Public invite words

The frozen 1,024-entry dictionary in `words.txt` is adapted from the Electronic Frontier
Foundation's [Short Wordlist 1](https://www.eff.org/files/2016/09/08/eff_short_wordlist_1.txt)
and [long wordlist](https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt),
with common concrete nouns added. Credit: Electronic Frontier Foundation, 2016.
Licensed under [CC BY 3.0 US](https://creativecommons.org/licenses/by/3.0/us/).
Changes: removed sensitive, negative, obscure and easily confused words; added common nouns;
sorted the resulting list. This is an English-language editorial selection, not a guarantee
against every possible interpretation of a random phrase in every dialect.

Each word consumes ten SHA-256 bits, without modulo bias. Four words provide 40 bits;
three provide 30 bits. The previous ten letters provide about 47 bits (10 log2 26,
slightly less with its byte-modulo mapping). These are bearer credentials, not passwords;
existing guest-entry limits, disable controls, and rotation still apply.

To choose three words **before this migration ships**, change `InviteWordCount` from 4 to 3
in `code.go`, then run `node scripts/codegen/invite-words.mjs --write`. This changes SQL's
`generate_series(0, 3)` to `(0, 2)` and the SDK's generated count. Routing already accepts
three- and four-word paths. Tests use the default four-word examples and need updating.
After release, freeze this dictionary and migration: changing count or vocabulary requires
a new migration and a compatibility plan for links already issued.
