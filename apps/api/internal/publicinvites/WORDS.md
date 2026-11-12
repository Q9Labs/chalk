# Public invite words

The frozen 1,024-entry dictionary in `words.txt` is adapted from the Electronic Frontier Foundation's [Short Wordlist 1](https://www.eff.org/files/2016/09/08/eff_short_wordlist_1.txt) and [long wordlist](https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt), with common concrete nouns added. Credit: Electronic Frontier Foundation, 2016. Licensed under [CC BY 3.0 US](https://creativecommons.org/licenses/by/3.0/us/).

Changes: removed sensitive, negative, obscure and easily confused words; added common positive or neutral nouns of 3 to 6 letters (no numbers, brands, sound-alikes or sensitive subjects); sorted. The list stays alphabetically sorted with exactly 1,024 unique entries. It is an English editorial selection, not a guarantee against every interpretation of a random phrase in every dialect.

Each word consumes ten SHA-256 bits with no modulo bias, so `InviteWordCount` words give `10 × count` bits. These are bearer credentials, not passwords, so guest-entry limits, disable controls and rotation still apply. Changing the count (`code.go`) or vocabulary requires `node scripts/codegen/invite-words.mjs --write` to regenerate the SQL and SDK, and, once links are issued, a new migration and a compatibility plan.
