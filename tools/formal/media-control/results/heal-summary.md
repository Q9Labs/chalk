| run | check | expect | outcome | overrides | machine | states | distinct | depth | seconds |
|---|---|---|---|---|---|---|---|---|---|
| heal-decided-safety | safety | pass | pass | defaults | Hasan’s MacBook Air | 10278432 | 1867947 | 57 | 32 |
| heal-decided-P5src | P5src | pass | pass | defaults | Hasan’s MacBook Air | 10278432 | 1867947 | 57 | 176 |
| heal-decided-P5 | P5 | pass | pass | defaults | Hasan’s MacBook Air | 10278432 | 1867947 | 57 | 231 |
| heal-decided-P4h | P4h | pass | pass | defaults | Hasan’s MacBook Air | 10278432 | 1867947 | 57 | 179 |
| heal-decided-S5c | S5c | pass | pass | defaults | Hasan’s MacBook Air | 10278432 | 1867947 | 57 | 188 |
| heal-sdk-today-P5src | P5src | violated | violated | RecoveryPause="item" | Hasan’s MacBook Air | 141356 | 39192 | 16 | 4 |
| heal-sdk-today-W4 | W4 | violated | violated | RecoveryPause="item" | Hasan’s MacBook Air | 2816 | 1075 | 8 | 0 |
| heal-decided-W4 | W4 | pass | pass | defaults | Hasan’s MacBook Air | 10278432 | 1867947 | 57 | 29 |
| heal-witness-W5 | W5 | violated | violated | defaults | Hasan’s MacBook Air | 95623 | 27070 | 15 | 2 |
| heal-hostmute-grant-safety | safety | pass | pass | MaxHostMute=1 | Hasan’s MacBook Air | 11120045 | 2035709 | 57 | 34 |
| heal-hostmute-grant-P1d | P1d | pass | pass | MaxHostMute=1 | Hasan’s MacBook Air | 11120045 | 2035709 | 57 | 195 |
| heal-hostmute-item-P1d | P1d | pass | pass | MaxHostMute=1 RecoveryPause="item" | Hasan’s MacBook Air | 11651106 | 2138187 | 57 | 235 |
| heal-hostmute-none-P1d | P1d | violated | violated | MaxHostMute=1 RecoveryPause="none" | Hasan’s MacBook Air | 187745 | 52291 | 16 | 4 |
| heal-retire-on-off-P5src | P5src | pass | pass | MuteKeepsPublication=FALSE | Hasan’s MacBook Air | 47140461 | 8017371 | 67 | 1161 |
| heal-selfdetect-P5src | P5src | pass | pass | PublisherSelfDetect=TRUE | Hasan’s MacBook Air | 26206487 | 4354502 | 55 | 514 |
| heal-nogc-selfdetect-P5src | P5src | pass | pass | SfuExpiresStale=FALSE PublisherSelfDetect=TRUE | Hasan’s MacBook Air | 25397456 | 4325694 | 55 | 569 |
| heal-S5b-stale-roster | S5b | violated | violated | defaults | Hasan’s MacBook Air | 34421 | 10164 | 13 | 1 |
| heal-S5d-no-pull-of-dead | S5d | pass | pass | defaults | Hasan’s MacBook Air | 10278432 | 1867947 | 57 | 27 |
| mutant-heal-nodead-P5src | P5src | violated | violated | DeadPath=FALSE | Hasan’s MacBook Air | 1152444 | 229353 | 45 | 22 |
| mutant-heal-noflat-P5src | P5src | violated | violated | FlatDrop=FALSE | Hasan’s MacBook Air | 133658 | 36443 | 16 | 3 |
| mutant-heal-norecv-P5src | P5src | violated | violated | RecvReconnect=FALSE | Hasan’s MacBook Air | 121336 | 33053 | 16 | 4 |
| mutant-heal-giveup-P5src | P5src | violated | violated | GiveUpAfter=2 | Hasan’s MacBook Air | 1969712 | 388519 | 45 | 33 |
| mutant-heal-nocap-P6 | P6 | violated | violated | RetryCap=FALSE | Hasan’s MacBook Air | 137535 | 37532 | 16 | 2 |
| mutant-heal-nocap-P5src | P5src | pass | pass | RetryCap=FALSE | Hasan’s MacBook Air | 32121544 | 5510003 | 73 | 642 |
| mutant-heal-nogc-P5src | P5src | violated | violated | SfuExpiresStale=FALSE | Hasan’s MacBook Air | 145923 | 41673 | 17 | 4 |
| heal-witness-W1 | W1 | violated | violated | defaults | Hasan’s MacBook Air | 17580 | 5305 | 11 | 0 |
| heal-witness-W2 | W2 | violated | violated | defaults | Hasan’s MacBook Air | 374677 | 94180 | 20 | 3 |
| heal-witness-W3 | W3 | violated | violated | defaults | Hasan’s MacBook Air | 53533 | 15614 | 14 | 1 |
