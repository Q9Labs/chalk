# Same-M4 matched comparison

Seconds; n; p50/p95/max. A and B are interleaved per scenario. Censored outcomes never count as zero.

| Scenario     | Arm | Eligible/attempts | Sync                    | State + outcomes        | Four media directions   | Action terminal outcome | Target |
| ------------ | --- | ----------------: | ----------------------- | ----------------------- | ----------------------- | ----------------------- | ------ |
| drop-5000    | A   |             10/10 | n=10; 0.090/0.111/0.111 | n=10; 0.344/0.366/0.366 | n=10; 1.106/1.158/1.158 | n=10; 5.204/5.256/5.256 | met    |
| drop-5000    | B   |             10/11 | n=10; 0.123/0.132/0.132 | n=10; 0.349/0.382/0.382 | n=10; 1.357/1.374/1.374 | n=10; 5.194/5.214/5.214 | met    |
| flapping     | A   |             10/10 | n=10; 1.278/3.870/3.870 | n=10; 1.272/3.868/3.868 | n=10; 1.062/2.383/2.383 | n=10; 2.389/3.217/3.217 | met    |
| flapping     | B   |             10/10 | n=10; 0.915/3.849/3.849 | n=10; 0.912/3.847/3.847 | n=10; 1.858/2.863/2.863 | n=10; 1.948/3.258/3.258 | met    |
| sync-restart | A   |               5/5 | n=5; 0.057/0.077/0.077  | n=5; 0.054/0.075/0.075  | n=5; 0.054/0.216/0.216  | n=5; 0.974/1.011/1.011  | met    |
| sync-restart | B   |               5/5 | n=5; 0.051/0.072/0.072  | n=5; 0.049/0.068/0.068  | n=5; 0.056/0.256/0.256  | n=5; 0.978/1.002/1.002  | met    |

Predeclared p95/max noise: Sync, state+outcomes, and actions ≤0.500 s; worst four-way media ≤1.000 s. Negative deltas favor B.

| Scenario     | Metric         | B − A p95 / max (s) | Bound (s) | Within noise |
| ------------ | -------------- | ------------------: | --------: | ------------ |
| drop-5000    | sync           |     +0.021 / +0.021 |     0.500 | yes          |
| drop-5000    | state          |     +0.016 / +0.016 |     0.500 | yes          |
| drop-5000    | mediaAllFour   |     +0.216 / +0.216 |     1.000 | yes          |
| drop-5000    | actionsSettled |     -0.042 / -0.042 |     0.500 | yes          |
| flapping     | sync           |     -0.021 / -0.021 |     0.500 | yes          |
| flapping     | state          |     -0.021 / -0.021 |     0.500 | yes          |
| flapping     | mediaAllFour   |     +0.480 / +0.480 |     1.000 | yes          |
| flapping     | actionsSettled |     +0.041 / +0.041 |     0.500 | yes          |
| sync-restart | sync           |     -0.005 / -0.005 |     0.500 | yes          |
| sync-restart | state          |     -0.007 / -0.007 |     0.500 | yes          |
| sync-restart | mediaAllFour   |     +0.040 / +0.040 |     1.000 | yes          |
| sync-restart | actionsSettled |     -0.009 / -0.009 |     0.500 | yes          |
