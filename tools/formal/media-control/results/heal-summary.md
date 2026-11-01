| run                         | check  | expect   | outcome  | overrides                                          | machine              | states   | distinct | depth | seconds |
| --------------------------- | ------ | -------- | -------- | -------------------------------------------------- | -------------------- | -------- | -------- | ----- | ------- |
| heal-decided-safety         | safety | pass     | pass     | defaults                                           | Instabox 4 vCPU 8 GB | 8702155  | 1617232  | 54    | 32      |
| heal-decided-P5src          | P5src  | pass     | pass     | defaults                                           | Instabox 4 vCPU 8 GB | 8702155  | 1617232  | 54    | 166     |
| heal-decided-P5             | P5     | pass     | pass     | defaults                                           | Instabox 4 vCPU 8 GB | 8702155  | 1617232  | 54    | 200     |
| heal-decided-P4h            | P4h    | pass     | pass     | defaults                                           | Instabox 4 vCPU 8 GB | 8702155  | 1617232  | 54    | 160     |
| heal-decided-S5c            | S5c    | pass     | pass     | defaults                                           | Instabox 4 vCPU 8 GB | 8702155  | 1617232  | 54    | 161     |
| heal-sdk-today-P5src        | P5src  | violated | violated | RecoveryPause="item"                               | Instabox 4 vCPU 8 GB | 50570    | 14791    | 14    | 4       |
| heal-sdk-today-W4           | W4     | violated | violated | RecoveryPause="item"                               | Instabox 4 vCPU 8 GB | 2671     | 998      | 7     | 0       |
| heal-decided-W4             | W4     | pass     | pass     | defaults                                           | Instabox 4 vCPU 8 GB | 8702155  | 1617232  | 54    | 28      |
| heal-witness-W5             | W5     | violated | violated | defaults                                           | Instabox 4 vCPU 8 GB | 98731    | 27935    | 15    | 2       |
| heal-hostmute-grant-safety  | safety | pass     | pass     | MaxHostMute=1                                      | Instabox 4 vCPU 8 GB | 9372896  | 1756410  | 54    | 32      |
| heal-hostmute-grant-P1d     | P1d    | pass     | pass     | MaxHostMute=1                                      | Instabox 4 vCPU 8 GB | 9372896  | 1756410  | 54    | 176     |
| heal-hostmute-item-P1d      | P1d    | pass     | pass     | MaxHostMute=1 RecoveryPause="item"                 | Instabox 4 vCPU 8 GB | 9766479  | 1835431  | 54    | 188     |
| heal-hostmute-none-P1d      | P1d    | violated | violated | MaxHostMute=1 RecoveryPause="none"                 | Instabox 4 vCPU 8 GB | 86601    | 25518    | 14    | 3       |
| heal-retire-on-off-P5src    | P5src  | pass     | pass     | MuteKeepsPublication=FALSE                         | Instabox 4 vCPU 8 GB | 43534550 | 7516309  | 67    | 969     |
| heal-selfdetect-P5src       | P5src  | pass     | pass     | PublisherSelfDetect=TRUE                           | Instabox 4 vCPU 8 GB | 21654511 | 3677785  | 52    | 442     |
| heal-nogc-selfdetect-P5src  | P5src  | pass     | pass     | SfuExpiresStale=FALSE PublisherSelfDetect=TRUE     | Instabox 4 vCPU 8 GB | 20942744 | 3648977  | 52    | 455     |
| heal-S5b-stale-roster       | S5b    | violated | violated | defaults                                           | Instabox 4 vCPU 8 GB | 70428    | 20322    | 15    | 1       |
| mutant-heal-nodead-P5src    | P5src  | violated | violated | DeadPath=FALSE                                     | Instabox 4 vCPU 8 GB | 912727   | 191368   | 44    | 17      |
| mutant-heal-noflat-P5src    | P5src  | violated | violated | FlatDrop=FALSE                                     | Instabox 4 vCPU 8 GB | 3846764  | 792079   | 35    | 64      |
| mutant-heal-norecv-P5src    | P5src  | violated | violated | RecvReconnect=FALSE                                | Instabox 4 vCPU 8 GB | 86697    | 24741    | 15    | 3       |
| mutant-heal-giveup-P5src    | P5src  | violated | violated | GiveUpAfter=2                                      | Instabox 4 vCPU 8 GB | 1595397  | 329442   | 42    | 28      |
| mutant-heal-nocap-P6        | P6     | violated | violated | RetryCap=FALSE                                     | Instabox 4 vCPU 8 GB | 135504   | 37569    | 16    | 2       |
| mutant-heal-nocap-P5src     | P5src  | pass     | pass     | RetryCap=FALSE                                     | Instabox 4 vCPU 8 GB | 27416099 | 4803416  | 70    | 563     |
| mutant-heal-nogc-P5src      | P5src  | violated | violated | SfuExpiresStale=FALSE                              | Instabox 4 vCPU 8 GB | 3686487  | 785211   | 34    | 64      |
| heal-witness-W1             | W1     | violated | violated | defaults                                           | Instabox 4 vCPU 8 GB | 17377    | 5348     | 11    | 1       |
| heal-witness-W2             | W2     | violated | violated | defaults                                           | Instabox 4 vCPU 8 GB | 384767   | 97423    | 20    | 3       |
| heal-witness-W3             | W3     | violated | violated | defaults                                           | Instabox 4 vCPU 8 GB | 53594    | 15533    | 14    | 1       |
| deep-heal-P5src-faults3     | P5src  | pass     | pass     | MaxFaults=3 MaxToggle=1                            | Instabox 4 vCPU 8 GB | 11885396 | 2181132  | 56    | 226     |
| deep-heal-safety-faults3    | safety | pass     | pass     | MaxFaults=3                                        | Instabox 4 vCPU 8 GB | 94290019 | 15541279 | 59    | 285     |
| deep-heal-P5src-2listeners  | P5src  | pass     | pass     | Listeners={l1,l2} MaxToggle=1 MaxFaults=1 MaxGen=3 | Instabox 4 vCPU 8 GB | 4075709  | 722177   | 48    | 97      |
| deep-heal-safety-2listeners | safety | pass     | pass     | Listeners={l1,l2} MaxToggle=1 MaxFaults=1 MaxGen=3 | Instabox 4 vCPU 8 GB | 2060274  | 365241   | 48    | 11      |
| deep-heal-S5c-2listeners    | S5c    | pass     | pass     | Listeners={l1,l2} MaxToggle=1 MaxFaults=1 MaxGen=3 | Instabox 4 vCPU 8 GB | 4075709  | 722177   | 48    | 97      |
