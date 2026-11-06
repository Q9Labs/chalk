| run | check | sources | seq | drops | loss | mutes | cfails | rule | ui | sfu | expect | outcome | states | distinct | depth | seconds |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cf-decided-safety-1src | safety | mic | 3 | 2 | 2 | 1 | 1 | decided | FALSE | cloudflare | pass | pass | 7165145 | 1176766 | 35 | 10 |
| cf-decided-live-1src | P4 | mic | 3 | 1 | 2 | 1 | 1 | decided | FALSE | cloudflare | pass | pass | 1660460 | 298666 | 30 | 13 |
| cf-decided-live-1src-d2 | P4 | mic | 2 | 2 | 2 | 1 | 1 | decided | FALSE | cloudflare | pass | pass | 1328652 | 224087 | 31 | 10 |
| own-decided-safety-1src | safety | mic | 3 | 2 | 2 | 1 | 0 | decided | FALSE | own | pass | pass | 2096638 | 396511 | 31 | 3 |
| own-decided-live-1src | P4 | mic | 3 | 1 | 2 | 1 | 0 | decided | FALSE | own | pass | pass | 597155 | 119445 | 27 | 6 |
| own-dist-safety-1src | safety | mic | 3 | 2 | 2 | 1 | 1 | decided | FALSE | own-distributed | pass | pass | 7165145 | 1176766 | 35 | 10 |
| own-dist-live-1src | P4 | mic | 3 | 1 | 2 | 1 | 1 | decided | FALSE | own-distributed | pass | pass | 1660460 | 298666 | 30 | 14 |
| cf-current-P2-1src | P2 | mic | 2 | 1 | 1 | 0 | 0 | current | FALSE | cloudflare | violated | violated | 526 | 236 | 8 | 1 |
| cf-current-P4-1src | P4 | mic | 2 | 0 | 1 | 0 | 0 | current | FALSE | cloudflare | violated | violated | 1128 | 362 | 15 | 0 |
| cf-current-P4-drop-1src | P4 | mic | 3 | 1 | 1 | 0 | 0 | current | FALSE | cloudflare | violated | violated | 37604 | 8732 | 22 | 1 |
| cf-current-P1-1src | P1 | mic | 3 | 2 | 2 | 1 | 1 | current | FALSE | cloudflare | pass | pass | 8807336 | 1474009 | 35 | 13 |
| cf-current-P3-1src | P3 | mic | 3 | 2 | 2 | 1 | 1 | current | FALSE | cloudflare | pass | pass | 8807336 | 1474009 | 35 | 14 |
| mutant-adoptSync-P1 | P1 | mic | 2 | 1 | 1 | 0 | 0 | adoptSync | FALSE | cloudflare | violated | violated | 2585 | 783 | 12 | 1 |
| mutant-optimisticUi-P3 | P3 | mic | 1 | 0 | 0 | 0 | 0 | decided | TRUE | cloudflare | violated | violated | 2 | 2 | 2 | 0 |
| witness-on | W1 | mic | 2 | 0 | 0 | 0 | 0 | decided | FALSE | cloudflare | violated | violated | 136 | 48 | 13 | 0 |
| witness-hostmute | W2 | mic | 2 | 0 | 0 | 1 | 0 | decided | FALSE | cloudflare | violated | violated | 1084 | 361 | 12 | 0 |
