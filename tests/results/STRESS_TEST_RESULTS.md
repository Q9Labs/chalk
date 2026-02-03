# Chalk Stress Test Results

> Auto-generated report. Each test run appends results below.

## Test Environment
- **Infrastructure**: chalk-stress (AWS us-east-1)
- **Test Framework**: k6 + Artillery + Custom Go Client

---

## Results Log

<!-- New results are appended below this line -->

### smoke - 2026-01-31 10:32:49 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "metrics": {
        "http_req_connecting": {
            "p(90)": 0,
            "p(95)": 0,
            "avg": 2.397334502923977,
            "min": 0,
            "med": 0,
            "max": 213.225
        },
        "http_req_receiving": {
            "min": 0.01,
            "med": 0.086,
            "max": 1.298,
            "p(90)": 0.131,
            "p(95)": 0.14329999999999996,
            "avg": 0.08833216374268986
        },
        "iteration_duration": {
            "max": 2773.559833,
            "p(90)": 2284.8514664000004,
            "p(95)": 2380.3088836,
            "avg": 2142.1832321438583,
            "min": 2018.7335,
            "med": 2097.221459
        },
        "http_req_tls_handshaking": {
            "min": 0,
            "med": 0,
            "max": 0,
            "p(90)": 0,
            "p(95)": 0,
            "avg": 0
        },
        "vus": {
            "value": 5,
            "min": 5,
            "max": 10
        },
        "data_received": {
            "count": 850011,
            "rate": 13726.393814895935
        },
        "iterations": {
            "count": 285,
            "rate": 4.602319543212196
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 855,
            "thresholds": {
                "rate<0.01": false
            },
            "value": 0
        },
        "http_req_sending": {
            "min": 0.003,
            "med": 0.024,
            "max": 0.33,
            "p(90)": 0.037,
            "p(95)": 0.044,
            "avg": 0.024907602339181253
        },
        "checks": {
            "passes": 1425,
            "fails": 0,
            "thresholds": {
                "rate>0.95": false
            },
            "value": 1
        },
        "http_req_duration": {
            "avg": 375.0195847953212,
            "min": 198.004,
            "med": 277.706,
            "max": 899.19,
            "p(90)": 629.8276000000001,
            "p(95)": 689.9160999999999,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "http_reqs": {
            "count": 855,
            "rate": 13.806958629636586
        },
        "http_req_blocked": {
            "p(95)": 0.012,
            "avg": 5.15470643274854,
            "min": 0.001,
            "med": 0.006,
            "max": 448.332,
            "p(90)": 0.011
        },
        "http_req_waiting": {
            "med": 277.606,
            "max": 899.118,
            "p(90)": 629.7294,
            "p(95)": 689.7484,
            "avg": 374.9063450292396,
```

</details>

---

### smoke - 2026-01-31 10:33:56 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "metrics": {
        "iteration_duration": {
            "max": 2564.426333,
            "p(90)": 2244.3653670000003,
            "p(95)": 2365.52643485,
            "avg": 2137.177325390847,
            "min": 2010.320041,
            "med": 2109.4797710000003
        },
        "http_req_duration{expected_response:true}": {
            "avg": 376.06942605633765,
            "min": 199.599,
            "med": 280.206,
            "max": 993.126,
            "p(90)": 633.2056,
            "p(95)": 678.83565
        },
        "iterations": {
            "count": 284,
            "rate": 4.603501098745487
        },
        "http_req_duration": {
            "max": 993.126,
            "p(90)": 633.2056,
            "p(95)": 678.83565,
            "avg": 376.06942605633765,
            "min": 199.599,
            "med": 280.206,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "vus_max": {
            "value": 10,
            "min": 10,
            "max": 10
        },
        "http_req_connecting": {
            "med": 0,
            "max": 219.26,
            "p(90)": 0,
            "p(95)": 0,
            "avg": 2.4373685446009388,
            "min": 0
        },
        "data_received": {
            "rate": 13730.47694086848,
            "count": 847063
        },
        "checks": {
            "fails": 0,
            "passes": 1420,
            "thresholds": {
                "rate>0.95": false
            },
            "value": 1
        },
        "http_req_receiving": {
            "med": 0.102,
            "max": 0.37,
            "p(90)": 0.138,
            "p(95)": 0.147,
            "avg": 0.09800117370892031,
            "min": 0.018
        },
        "http_reqs": {
            "count": 852,
            "rate": 13.810503296236462
        },
        "http_req_sending": {
            "max": 1.081,
            "p(90)": 0.037,
            "p(95)": 0.041,
            "avg": 0.029050469483568004,
            "min": 0.006,
            "med": 0.028
        },
        "http_req_blocked": {
            "avg": 2.458835680751174,
            "min": 0.001,
            "med": 0.008,
            "max": 220.509,
            "p(90)": 0.011,
            "p(95)": 0.012
        },
        "vus": {
            "value": 4,
            "min": 4,
            "max": 10
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 852,
            "thresholds": {
                "rate<0.01": false
            },
            "value": 0
        },
        "data_sent": {
```

</details>

---

### room-creation - 2026-01-31 11:04:46 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "root_group": {
        "name": "",
        "path": "",
        "id": "d41d8cd98f00b204e9800998ecf8427e",
        "groups": {},
        "checks": {
                "room created": {
                    "fails": 0,
                    "name": "room created",
                    "path": "::room created",
                    "id": "fe4127567287937dd2f83625f48bd4d4",
                    "passes": 840
                },
                "room ended": {
                    "passes": 840,
                    "fails": 0,
                    "name": "room ended",
                    "path": "::room ended",
                    "id": "4c133d716191d4b40006ca3ab30e0220"
                }
            }
    },
    "metrics": {
        "iteration_duration": {
            "med": 1374.6951875,
            "max": 6915.887417,
            "p(90)": 1635.7026459,
            "p(95)": 1778.2007651999998,
            "avg": 1384.0038068464276,
            "min": 408.402167
        },
        "rooms_created": {
            "count": 840,
            "rate": 1.7458296494249363,
            "thresholds": {
                "count>500": false
            }
        },
        "http_req_duration{expected_response:true}": {
            "p(95)": 1006.3567499999999,
            "avg": 688.8351920332916,
            "min": 201.709,
            "med": 696.5765,
            "max": 4318.856,
            "p(90)": 877.0684000000001
        },
        "http_req_connecting": {
            "min": 0,
            "med": 0,
            "max": 212.818,
            "p(90)": 0,
            "p(95)": 0,
            "avg": 2.5342615933412604
        },
        "http_req_sending": {
            "max": 1.399,
            "p(90)": 0.036,
            "p(95)": 0.043,
            "avg": 0.022406658739595707,
            "min": 0.005,
            "med": 0.018
        },
        "room_create_time": {
            "avg": 626.6892857142857,
            "min": 202,
            "med": 605,
            "max": 4077,
            "p(90)": 793,
            "p(95)": 885.1999999999998,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "vus_max": {
            "value": 20,
            "min": 20,
            "max": 20
        },
        "http_req_tls_handshaking": {
            "min": 0,
            "med": 0,
            "max": 0,
            "p(90)": 0,
            "p(95)": 0,
            "avg": 0
        },
        "iterations": {
            "count": 840,
            "rate": 1.7458296494249363
        },
        "http_req_duration": {
            "p(95)": 1006.3567499999999,
            "avg": 688.8351920332916,
            "min": 201.709,
            "med": 696.5765,
            "max": 4318.856,
            "p(90)": 877.0684000000001
        },
        "vus": {
```

</details>

---

### smoke - 2026-01-31 11:07:28 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "metrics": {
        "vus": {
            "value": 7,
            "min": 7,
            "max": 10
        },
        "iteration_duration": {
            "p(90)": 1732.927688,
            "p(95)": 1758.2100934999999,
            "avg": 1711.8054786994383,
            "min": 1672.620416,
            "med": 1694.5664785,
            "max": 2293.045625
        },
        "data_received": {
            "count": 1061775,
            "rate": 17247.780400598796
        },
        "iterations": {
            "count": 356,
            "rate": 5.782967034082713
        },
        "checks": {
            "passes": 1780,
            "fails": 0,
            "thresholds": {
                "rate>0.95": false
            },
            "value": 1
        },
        "http_req_duration{expected_response:true}": {
            "max": 431.907,
            "p(90)": 287.2819,
            "p(95)": 292.99195,
            "avg": 232.73607116104853,
            "min": 198.331,
            "med": 209.6865
        },
        "http_req_sending": {
            "p(95)": 0.035,
            "avg": 0.020955056179775226,
            "min": 0.003,
            "med": 0.019,
            "max": 0.318,
            "p(90)": 0.031
        },
        "vus_max": {
            "value": 10,
            "min": 10,
            "max": 10
        },
        "http_req_blocked": {
            "min": 0,
            "med": 0.005,
            "max": 449.795,
            "p(90)": 0.009,
            "p(95)": 0.01,
            "avg": 4.074735955056181
        },
        "http_reqs": {
            "rate": 17.34890110224814,
            "count": 1068
        },
        "http_req_receiving": {
            "med": 0.066,
            "max": 1.358,
            "p(90)": 0.115,
            "p(95)": 0.12664999999999996,
            "avg": 0.07054775280898867,
            "min": 0.013
        },
        "http_req_duration": {
            "avg": 232.73607116104853,
            "min": 198.331,
            "med": 209.6865,
            "max": 431.907,
            "p(90)": 287.2819,
            "p(95)": 292.99195,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 1068,
            "thresholds": {
                "rate<0.01": false
            },
            "value": 0
        },
        "http_req_waiting": {
            "avg": 232.6445683520599,
            "min": 198.174,
            "med": 209.59449999999998,
            "max": 431.874,
            "p(90)": 287.1923,
            "p(95)": 292.8734
        },
        "http_req_tls_handshaking": {
```

</details>

---

### smoke - 2026-01-31 11:10:57 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "metrics": {
        "http_req_blocked": {
            "max": 450.137,
            "p(90)": 0.005,
            "p(95)": 0.006,
            "avg": 4.1646365348400085,
            "min": 0,
            "med": 0.003
        },
        "http_req_waiting": {
            "avg": 234.48580414312602,
            "min": 198.192,
            "med": 211.492,
            "max": 658.321,
            "p(90)": 282.4726,
            "p(95)": 285.71295
        },
        "http_reqs": {
            "count": 1062,
            "rate": 17.28307603601422
        },
        "http_req_duration{expected_response:true}": {
            "avg": 234.54509227871938,
            "min": 198.238,
            "med": 211.5315,
            "max": 658.371,
            "p(90)": 282.52639999999997,
            "p(95)": 285.74785
        },
        "checks": {
            "passes": 1770,
            "fails": 0,
            "thresholds": {
                "rate>0.95": false
            },
            "value": 1
        },
        "vus": {
            "value": 4,
            "min": 4,
            "max": 10
        },
        "http_req_tls_handshaking": {
            "avg": 0,
            "min": 0,
            "med": 0,
            "max": 0,
            "p(90)": 0,
            "p(95)": 0
        },
        "vus_max": {
            "value": 10,
            "min": 10,
            "max": 10
        },
        "iteration_duration": {
            "avg": 1717.2679272627101,
            "min": 1671.996,
            "med": 1696.4888335,
            "max": 2272.449542,
            "p(90)": 1723.8589666999999,
            "p(95)": 1787.95456875
        },
        "http_req_connecting": {
            "min": 0,
            "med": 0,
            "max": 213.638,
            "p(90)": 0,
            "p(95)": 0,
            "avg": 1.9350423728813562
        },
        "data_sent": {
            "count": 395772,
            "rate": 6440.8263360879655
        },
        "http_req_sending": {
            "max": 0.122,
            "p(90)": 0.019,
            "p(95)": 0.023,
            "avg": 0.012895480225988612,
            "min": 0.003,
            "med": 0.011
        },
        "iterations": {
            "count": 354,
            "rate": 5.761025345338073
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 1062,
            "thresholds": {
                "rate<0.01": false
            },
            "value": 0
        },
        "http_req_receiving": {
            "p(90)": 0.072,
            "p(95)": 0.082,
            "avg": 0.04639265536723155,
```

</details>

---

### room-creation - 2026-01-31 11:19:59 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "root_group": {
        "groups": {},
        "checks": {
                "room created": {
                    "name": "room created",
                    "path": "::room created",
                    "id": "fe4127567287937dd2f83625f48bd4d4",
                    "passes": 839,
                    "fails": 0
                },
                "room ended": {
                    "name": "room ended",
                    "path": "::room ended",
                    "id": "4c133d716191d4b40006ca3ab30e0220",
                    "passes": 839,
                    "fails": 0
                }
            },
        "name": "",
        "path": "",
        "id": "d41d8cd98f00b204e9800998ecf8427e"
    },
    "metrics": {
        "room_create_time": {
            "avg": 216.70202622169248,
            "min": 202,
            "med": 210,
            "max": 636,
            "p(90)": 218,
            "p(95)": 234,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "http_reqs": {
            "rate": 3.4926885194334023,
            "count": 1679
        },
        "rooms_created": {
            "count": 839,
            "rate": 1.7453041499729747,
            "thresholds": {
                "count>500": false
            }
        },
        "http_req_blocked": {
            "min": 0.001,
            "med": 0.006,
            "max": 441.186,
            "p(90)": 0.012,
            "p(95)": 0.014,
            "avg": 2.710111971411521
        },
        "http_req_connecting": {
            "avg": 2.561346039309112,
            "min": 0,
            "med": 0,
            "max": 212.784,
            "p(90)": 0,
            "p(95)": 0
        },
        "http_req_tls_handshaking": {
            "max": 0,
            "p(90)": 0,
            "p(95)": 0,
            "avg": 0,
            "min": 0,
            "med": 0
        },
        "http_req_receiving": {
            "p(95)": 0.148,
            "avg": 0.08953365098272766,
            "min": 0.03,
            "med": 0.085,
            "max": 0.394,
            "p(90)": 0.13420000000000004
        },
        "vus": {
            "value": 0,
            "min": 0,
            "max": 1
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 1679,
            "thresholds": {
                "rate<0.1": false
            },
            "value": 0
        },
        "data_received": {
            "count": 1462082,
            "rate": 3041.451468654096
        },
        "http_req_duration": {
            "max": 635.864,
            "p(90)": 218.2458,
            "p(95)": 221.33429999999998,
            "avg": 212.59034067897574,
```

</details>

---

### smoke - 2026-01-31 11:26:23 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "metrics": {
        "http_reqs": {
            "count": 1062,
            "rate": 17.23249364843873
        },
        "http_req_blocked": {
            "max": 423.127,
            "p(90)": 0.003,
            "p(95)": 0.004,
            "avg": 3.8966440677967866,
            "min": 0,
            "med": 0.002
        },
        "http_req_tls_handshaking": {
            "max": 0,
            "p(90)": 0,
            "p(95)": 0,
            "avg": 0,
            "min": 0,
            "med": 0
        },
        "http_req_receiving": {
            "p(95)": 0.074,
            "avg": 0.03703295668549909,
            "min": 0.01,
            "med": 0.032,
            "max": 0.172,
            "p(90)": 0.068
        },
        "data_received": {
            "rate": 17138.088141803495,
            "count": 1056182
        },
        "checks": {
            "passes": 1770,
            "fails": 0,
            "thresholds": {
                "rate>0.95": false
            },
            "value": 1
        },
        "http_req_connecting": {
            "med": 0,
            "max": 215.209,
            "p(90)": 0,
            "p(95)": 0,
            "avg": 1.9365442561205275,
            "min": 0
        },
        "http_req_waiting": {
            "med": 212.335,
            "max": 503.11,
            "p(90)": 284.7305,
            "p(95)": 294.94825,
            "avg": 235.094667608286,
            "min": 197.845
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 1062,
            "thresholds": {
                "rate<0.01": false
            },
            "value": 0
        },
        "data_sent": {
            "rate": 6421.975966318167,
            "count": 395772
        },
        "iterations": {
            "count": 354,
            "rate": 5.744164549479576
        },
        "http_req_duration{expected_response:true}": {
            "avg": 235.14091242937863,
            "min": 197.867,
            "med": 212.3865,
            "max": 503.136,
            "p(90)": 284.7794,
            "p(95)": 294.99
        },
        "http_req_duration": {
            "p(95)": 294.99,
            "avg": 235.14091242937863,
            "min": 197.867,
            "med": 212.3865,
            "max": 503.136,
            "p(90)": 284.7794,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "vus": {
            "value": 3,
            "min": 3,
            "max": 10
        },
        "vus_max": {
            "max": 10,
```

</details>

---

### room-creation - 2026-01-31 11:29:24 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "root_group": {
        "name": "",
        "path": "",
        "id": "d41d8cd98f00b204e9800998ecf8427e",
        "groups": {},
        "checks": {
                "room created": {
                    "fails": 0,
                    "name": "room created",
                    "path": "::room created",
                    "id": "fe4127567287937dd2f83625f48bd4d4",
                    "passes": 195
                },
                "room ended": {
                    "name": "room ended",
                    "path": "::room ended",
                    "id": "4c133d716191d4b40006ca3ab30e0220",
                    "passes": 195,
                    "fails": 0
                }
            }
    },
    "metrics": {
        "http_req_blocked": {
            "avg": 11.34251150895141,
            "min": 0.002,
            "med": 0.009,
            "max": 367.906,
            "p(90)": 0.013,
            "p(95)": 198.185
        },
        "http_req_sending": {
            "avg": 0.03587723785166238,
            "min": 0.007,
            "med": 0.032,
            "max": 0.104,
            "p(90)": 0.053,
            "p(95)": 0.06649999999999999
        },
        "rooms_created": {
            "count": 195,
            "rate": 1.6108815228609739,
            "thresholds": {
                "count>100": false
            }
        },
        "http_req_duration": {
            "avg": 211.62489002557567,
            "min": 202.066,
            "med": 208.935,
            "max": 306.39,
            "p(90)": 219.654,
            "p(95)": 226.825
        },
        "iteration_duration": {
            "max": 697.668375,
            "p(90)": 571.7606754000003,
            "p(95)": 622.8108499,
            "avg": 444.52417775897385,
            "min": 406.962,
            "med": 420.462833
        },
        "vus": {
            "value": 1,
            "min": 0,
            "max": 1
        },
        "vus_max": {
            "max": 20,
            "value": 20,
            "min": 20
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 391,
            "thresholds": {
                "rate<0.1": false
            },
            "value": 0
        },
        "http_req_duration{expected_response:true}": {
            "avg": 211.62489002557567,
            "min": 202.066,
            "med": 208.935,
            "max": 306.39,
            "p(90)": 219.654,
            "p(95)": 226.825
        },
        "http_req_receiving": {
            "max": 0.919,
            "p(90)": 0.144,
            "p(95)": 0.15049999999999997,
            "avg": 0.11306138107416872,
            "min": 0.033,
            "med": 0.113
        },
        "data_received": {
            "count": 340773,
            "rate": 2815.10220097386
```

</details>

---

### smoke - 2026-01-31 11:35:29 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "metrics": {
        "http_req_tls_handshaking": {
            "p(95)": 0,
            "avg": 0,
            "min": 0,
            "med": 0,
            "max": 0,
            "p(90)": 0
        },
        "http_req_receiving": {
            "p(95)": 0.138,
            "avg": 0.0980197740112991,
            "min": 0.013,
            "med": 0.1055,
            "max": 0.474,
            "p(90)": 0.128
        },
        "http_req_blocked": {
            "avg": 4.133732580037634,
            "min": 0.001,
            "med": 0.007,
            "max": 446.315,
            "p(90)": 0.01,
            "p(95)": 0.011
        },
        "http_req_waiting": {
            "p(95)": 291.92105,
            "avg": 234.41118832391703,
            "min": 198.063,
            "med": 209.8915,
            "max": 721.011,
            "p(90)": 279.6765
        },
        "vus": {
            "value": 4,
            "min": 4,
            "max": 10
        },
        "http_req_connecting": {
            "avg": 1.9196290018832391,
            "min": 0,
            "med": 0,
            "max": 212.119,
            "p(90)": 0,
            "p(95)": 0
        },
        "vus_max": {
            "value": 10,
            "min": 10,
            "max": 10
        },
        "checks": {
            "passes": 1770,
            "fails": 0,
            "thresholds": {
                "rate>0.95": false
            },
            "value": 1
        },
        "http_req_duration": {
            "max": 721.171,
            "p(90)": 279.8101,
            "p(95)": 292.00139999999993,
            "avg": 234.53535593220363,
            "min": 198.172,
            "med": 209.982,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "iteration_duration": {
            "avg": 1718.1305049774003,
            "min": 1673.163333,
            "med": 1694.1384375,
            "max": 2316.164291,
            "p(90)": 1737.4297043,
            "p(95)": 1785.4666209499999
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 1062,
            "thresholds": {
                "rate<0.01": false
            },
            "value": 0
        },
        "data_sent": {
            "count": 395772,
            "rate": 6442.566164813641
        },
        "http_reqs": {
            "count": 1062,
            "rate": 17.28774462830136
        },
        "data_received": {
            "count": 1056159,
            "rate": 17192.662032845707
        },
        "iterations": {
```

</details>

---

### room-creation - 2026-01-31 11:38:30 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "root_group": {
        "name": "",
        "path": "",
        "id": "d41d8cd98f00b204e9800998ecf8427e",
        "groups": {},
        "checks": {
                "room created": {
                    "path": "::room created",
                    "id": "fe4127567287937dd2f83625f48bd4d4",
                    "passes": 194,
                    "fails": 0,
                    "name": "room created"
                },
                "room ended": {
                    "name": "room ended",
                    "path": "::room ended",
                    "id": "4c133d716191d4b40006ca3ab30e0220",
                    "passes": 194,
                    "fails": 0
                }
            }
    },
    "metrics": {
        "http_reqs": {
            "count": 389,
            "rate": 3.2221866686458127
        },
        "http_req_sending": {
            "avg": 0.04473264781490999,
            "min": 0.008,
            "med": 0.035,
            "max": 0.83,
            "p(90)": 0.057,
            "p(95)": 0.09239999999999993
        },
        "http_req_connecting": {
            "med": 0,
            "max": 224.115,
            "p(90)": 0,
            "p(95)": 198.2466,
            "avg": 11.093930591259642,
            "min": 0
        },
        "http_req_waiting": {
            "p(95)": 224.9592,
            "avg": 211.7527069408741,
            "min": 201.941,
            "med": 209.315,
            "max": 279.64,
            "p(90)": 223.6874
        },
        "http_req_tls_handshaking": {
            "max": 0,
            "p(90)": 0,
            "p(95)": 0,
            "avg": 0,
            "min": 0,
            "med": 0
        },
        "iterations": {
            "count": 194,
            "rate": 1.606951706214107
        },
        "http_req_receiving": {
            "avg": 0.1318766066838047,
            "min": 0.042,
            "med": 0.126,
            "max": 1.767,
            "p(90)": 0.1552,
            "p(95)": 0.169
        },
        "data_received": {
            "count": 338969,
            "rate": 2807.767076823143
        },
        "checks": {
            "fails": 0,
            "passes": 388,
            "value": 1
        },
        "http_req_blocked": {
            "min": 0.002,
            "med": 0.01,
            "max": 442.115,
            "p(90)": 0.014,
            "p(95)": 198.3722,
            "avg": 11.719174807197948
        },
        "iteration_duration": {
            "avg": 445.61769715463925,
            "min": 406.867459,
            "med": 422.391021,
            "max": 678.179083,
            "p(90)": 568.9391080000005,
            "p(95)": 624.5624476
        },
        "room_create_time": {
            "avg": 232.30927835051546,
            "min": 203,
```

</details>

---

### participant-churn - 2026-01-31 11:42:47 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "metrics": {
        "http_req_receiving": {
            "med": 0.102,
            "max": 1.065,
            "p(90)": 0.1472,
            "p(95)": 0.18119999999999997,
            "avg": 0.12277037037037035,
            "min": 0.046
        },
        "http_req_duration": {
            "avg": 222.66530370370378,
            "min": 204.443,
            "med": 216.912,
            "max": 340.257,
            "p(90)": 238.9402,
            "p(95)": 259.66669999999993
        },
        "ws_sessions": {
            "count": 132,
            "rate": 0.6720794109480576
        },
        "ws_session_duration": {
            "p(90)": 20429.8205506,
            "p(95)": 20439.98740395,
            "avg": 20416.167819742423,
            "min": 20397.903458,
            "med": 20411.803520499998,
            "max": 20574.024083
        },
        "http_req_sending": {
            "avg": 0.059177777777777774,
            "min": 0.015,
            "med": 0.048,
            "max": 0.231,
            "p(90)": 0.113,
            "p(95)": 0.1253
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 135,
            "value": 0
        },
        "data_sent": {
            "count": 229544,
            "rate": 1168.725729595916
        },
        "iterations": {
            "rate": 0.6720794109480576,
            "count": 132
        },
        "ws_connecting": {
            "p(90)": 428.6007917,
            "p(95)": 438.5283792,
            "avg": 414.7709444015153,
            "min": 396.139291,
            "med": 410.423125,
            "max": 572.714
        },
        "participant_joins": {
            "count": 132,
            "rate": 0.6720794109480576,
            "thresholds": {
                "count>50": false
            }
        },
        "http_req_duration{expected_response:true}": {
            "p(90)": 238.9402,
            "p(95)": 259.66669999999993,
            "avg": 222.66530370370378,
            "min": 204.443,
            "med": 216.912,
            "max": 340.257
        },
        "checks": {
            "passes": 264,
            "fails": 0,
            "value": 1
        },
        "ws_connect_latency": {
            "avg": 415.00757575757575,
            "min": 396,
            "med": 411,
            "max": 573,
            "p(90)": 428.9,
            "p(95)": 438.45,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "vus": {
            "value": 0,
            "min": 0,
            "max": 20
        },
        "iteration_duration": {
            "p(90)": 20828.713454499997,
            "p(95)": 20849.3322859,
            "avg": 20670.422243371213,
            "min": 20605.214416,
```

</details>

---

### smoke - 2026-01-31 11:48:51 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "metrics": {
        "http_req_blocked": {
            "avg": 6.283107619047614,
            "min": 0.001,
            "med": 0.007,
            "max": 663.375,
            "p(90)": 0.011,
            "p(95)": 0.012
        },
        "vus_max": {
            "value": 10,
            "min": 10,
            "max": 10
        },
        "http_req_sending": {
            "med": 0.026,
            "max": 0.195,
            "p(90)": 0.036,
            "p(95)": 0.041,
            "avg": 0.025242857142857084,
            "min": 0.003
        },
        "iteration_duration": {
            "avg": 1737.376812965714,
            "min": 1671.170875,
            "med": 1693.9507294999999,
            "max": 2570.4675,
            "p(90)": 1761.8147413,
            "p(95)": 2099.2234894
        },
        "http_req_duration{expected_response:true}": {
            "avg": 239.00254666666692,
            "min": 198.109,
            "med": 209.938,
            "max": 919.435,
            "p(90)": 279.1753,
            "p(95)": 293.76059999999995
        },
        "http_req_waiting": {
            "max": 919.332,
            "p(90)": 279.0116,
            "p(95)": 293.61699999999996,
            "avg": 238.8862257142855,
            "min": 198.02,
            "med": 209.83300000000003
        },
        "http_req_connecting": {
            "avg": 1.9396057142857146,
            "min": 0,
            "med": 0,
            "max": 208.141,
            "p(90)": 0,
            "p(95)": 0
        },
        "http_req_duration": {
            "avg": 239.00254666666692,
            "min": 198.109,
            "med": 209.938,
            "max": 919.435,
            "p(90)": 279.1753,
            "p(95)": 293.76059999999995,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "iterations": {
            "count": 350,
            "rate": 5.715279286430072
        },
        "data_received": {
            "count": 1044248,
            "rate": 17051.911326560086
        },
        "http_req_receiving": {
            "max": 1.686,
            "p(90)": 0.133,
            "p(95)": 0.149,
            "avg": 0.09107809523809517,
            "min": 0.012,
            "med": 0.096
        },
        "http_reqs": {
            "count": 1050,
            "rate": 17.145837859290218
        },
        "checks": {
            "passes": 1750,
            "fails": 0,
            "thresholds": {
                "rate>0.95": false
            },
            "value": 1
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 1050,
            "thresholds": {
                "rate<0.01": false
            },
```

</details>

---

### room-creation - 2026-01-31 11:51:52 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "setup_data": {
        "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJjaGFsayIsInN1YiI6ImYyZDI5YmIwLWE3ODYtNDIxNy05YThjLThmOThhODMwZjZlNSIsImV4cCI6MTc2OTg2Mzc5MiwiaWF0IjoxNzY5ODYwMTkyLCJqdGkiOiJycGx1cWZzc0ZkMDExQk5PMl9BRjh3IiwidGVuYW50X2lkIjoiZjJkMjliYjAtYTc4Ni00MjE3LTlhOGMtOGY5OGE4MzBmNmU1Iiwicm9vbV9pZCI6IjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMCIsInBlcm1pc3Npb25zIjp7ImNhbl9yZWNvcmQiOnRydWUsImNhbl9zY3JlZW5fc2hhcmUiOnRydWUsImNhbl9raWNrIjp0cnVlLCJjYW5fbXV0ZSI6dHJ1ZX0sInR5cGUiOiJhY2Nlc3MifQ.MPo7KTwZWEHw56dNk48Sc8Vg7r9JOGADzgedaTCjYP4"
    },
    "root_group": {
        "name": "",
        "path": "",
        "id": "d41d8cd98f00b204e9800998ecf8427e",
        "groups": {},
        "checks": {
                "room created": {
                    "name": "room created",
                    "path": "::room created",
                    "id": "fe4127567287937dd2f83625f48bd4d4",
                    "passes": 194,
                    "fails": 0
                },
                "room ended": {
                    "id": "4c133d716191d4b40006ca3ab30e0220",
                    "passes": 194,
                    "fails": 0,
                    "name": "room ended",
                    "path": "::room ended"
                }
            }
    },
    "metrics": {
        "http_req_connecting": {
            "p(95)": 198.0608,
            "avg": 11.02719794344473,
            "min": 0,
            "med": 0,
            "max": 218.923,
            "p(90)": 0
        },
        "checks": {
            "fails": 0,
            "passes": 388,
            "value": 1
        },
        "http_req_receiving": {
            "min": 0.031,
            "med": 0.089,
            "max": 1.221,
            "p(90)": 0.142,
            "p(95)": 0.1576,
            "avg": 0.10166066838046274
        },
        "rooms_created": {
            "count": 194,
            "rate": 1.607169700013077,
            "thresholds": {
                "count>100": false
            }
        },
        "vus": {
            "value": 0,
            "min": 0,
            "max": 2
        },
        "vus_max": {
            "value": 20,
            "min": 20,
            "max": 20
        },
        "rooms_ended": {
            "rate": 1.607169700013077,
            "count": 194
        },
        "http_req_tls_handshaking": {
            "avg": 0,
            "min": 0,
            "med": 0,
            "max": 0,
            "p(90)": 0,
            "p(95)": 0
        },
        "iteration_duration": {
            "avg": 454.47842784020634,
            "min": 406.585625,
            "med": 422.46331250000003,
            "max": 1265.082875,
            "p(90)": 611.6996875,
            "p(95)": 629.4348353
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 389,
            "thresholds": {
                "rate<0.1": false
            },
            "value": 0
        },
        "http_req_waiting": {
            "p(90)": 222.713,
            "p(95)": 225.99979999999996,
            "avg": 216.4045629820052,
            "min": 201.763,
            "med": 209.843,
            "max": 845.456
```

</details>

---

### participant-churn - 2026-01-31 11:56:08 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "root_group": {
        "groups": {},
        "checks": {
                "participant added": {
                    "id": "5778583306cac5bb605cb5048fe3e9cc",
                    "passes": 131,
                    "fails": 0,
                    "name": "participant added",
                    "path": "::participant added"
                },
                "ws connected": {
                    "name": "ws connected",
                    "path": "::ws connected",
                    "id": "b890c791400ee254856ecce8133edded",
                    "passes": 131,
                    "fails": 0
                }
            },
        "name": "",
        "path": "",
        "id": "d41d8cd98f00b204e9800998ecf8427e"
    },
    "metrics": {
        "participant_joins": {
            "rate": 0.6680027673875868,
            "count": 131,
            "thresholds": {
                "count>50": false
            }
        },
        "ws_connect_latency": {
            "avg": 461.19083969465646,
            "min": 396,
            "med": 411,
            "max": 2441,
            "p(90)": 435,
            "p(95)": 439.5,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "join_latency": {
            "avg": 269.10687022900765,
            "min": 205,
            "med": 218,
            "max": 1455,
            "p(90)": 417,
            "p(95)": 439.5,
            "thresholds": {
                "p(95)<2000": false
            }
        },
        "http_req_blocked": {
            "med": 0.006,
            "max": 1211.982,
            "p(90)": 202.7863,
            "p(95)": 208.06494999999998,
            "avg": 42.92497014925371,
            "min": 0.002
        },
        "http_req_receiving": {
            "med": 0.0605,
            "max": 0.89,
            "p(90)": 0.13810000000000003,
            "p(95)": 0.16024999999999992,
            "avg": 0.07787313432835817,
            "min": 0.026
        },
        "http_req_connecting": {
            "p(95)": 205.5613,
            "avg": 41.12020895522388,
            "min": 0,
            "med": 0,
            "max": 1211.869,
            "p(90)": 201.5739
        },
        "ws_sessions": {
            "count": 131,
            "rate": 0.6680027673875868
        },
        "ws_session_duration": {
            "max": 22441.865625,
            "p(90)": 20435.499375,
            "p(95)": 20441.165896,
            "avg": 20462.30535943511,
            "min": 20396.88575,
            "med": 20411.910625
        },
        "http_req_sending": {
            "min": 0.011,
            "med": 0.0285,
            "max": 0.226,
            "p(90)": 0.09340000000000001,
            "p(95)": 0.13574999999999998,
            "avg": 0.04111940298507461
        },
        "vus": {
            "value": 0,
            "min": 0,
```

</details>

---

### large-room - 2026-01-31 12:00:40 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "root_group": {
        "groups": {},
        "checks": {},
        "name": "",
        "path": "",
        "id": "d41d8cd98f00b204e9800998ecf8427e"
    },
    "metrics": {
        "ws_sessions": {
            "count": 63,
            "rate": 0.29867577118913774
        },
        "http_req_duration": {
            "avg": 235.96721538461537,
            "min": 204.048,
            "med": 212.86,
            "max": 1032.128,
            "p(90)": 230.8378,
            "p(95)": 268.7027999999999
        },
        "http_req_blocked": {
            "med": 205.195,
            "max": 1217.797,
            "p(90)": 216.28680000000003,
            "p(95)": 393.39439999999934,
            "avg": 241.32696923076915,
            "min": 0.002
        },
        "messages_received": {
            "count": 12273,
            "rate": 58.18488475879822
        },
        "ws_msgs_sent": {
            "count": 1022,
            "rate": 4.84518473262379
        },
        "http_req_duration{expected_response:true}": {
            "med": 212.86,
            "max": 1032.128,
            "p(90)": 230.8378,
            "p(95)": 268.7027999999999,
            "avg": 235.96721538461537,
            "min": 204.048
        },
        "http_req_connecting": {
            "avg": 237.67703076923075,
            "min": 0,
            "med": 204.999,
            "max": 1217.752,
            "p(90)": 213.1946,
            "p(95)": 218.2398
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 65,
            "value": 0
        },
        "broadcast_latency": {
            "p(95)": 386.24999999999915,
            "avg": 225.9018912529551,
            "min": 197,
            "med": 204,
            "max": 1040,
            "p(90)": 218,
            "thresholds": {
                "p(95)<500": false,
                "p(99)<1000": false
            }
        },
        "data_sent": {
            "rate": 898.0469306868827,
            "count": 189426
        },
        "vus_max": {
            "value": 40,
            "min": 40,
            "max": 40
        },
        "ws_connecting": {
            "avg": 490.30039150793647,
            "min": 396.992667,
            "med": 410.352166,
            "max": 2415.187334,
            "p(90)": 665.688767,
            "p(95)": 755.2223954999998
        },
        "iterations": {
            "count": 31,
            "rate": 0.14696744296608366
        },
        "participants_joined": {
            "count": 63,
            "rate": 0.29867577118913774,
            "thresholds": {
                "count>20": false
            }
        },
        "http_req_sending": {
            "avg": 0.06506153846153845,
```

</details>

---

### ws-storm - 2026-01-31 12:02:43 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "root_group": {
        "name": "",
        "path": "",
        "id": "d41d8cd98f00b204e9800998ecf8427e",
        "groups": {},
        "checks": {
                "ws connected": {
                    "name": "ws connected",
                    "path": "::ws connected",
                    "id": "b890c791400ee254856ecce8133edded",
                    "passes": 20,
                    "fails": 0
                }
            }
    },
    "metrics": {
        "ws_sessions": {
            "count": 20,
            "rate": 0.3214279113533963
        },
        "http_req_connecting": {
            "min": 0,
            "med": 200.91449999999998,
            "max": 217.388,
            "p(90)": 213.5909,
            "p(95)": 214.25045,
            "avg": 194.78581818181817
        },
        "iterations": {
            "rate": 0.3214279113533963,
            "count": 20
        },
        "vus_max": {
            "value": 20,
            "min": 20,
            "max": 20
        },
        "message_error_rate": {
            "fails": 23983,
            "passes": 0,
            "thresholds": {
                "rate<0.05": false
            },
            "value": 0
        },
        "http_reqs": {
            "count": 22,
            "rate": 0.35357070248873596
        },
        "http_req_duration": {
            "med": 385.8515,
            "max": 520.223,
            "p(90)": 471.34250000000003,
            "p(95)": 496.58234999999996,
            "avg": 353.5345454545454,
            "min": 217.696
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 22,
            "value": 0
        },
        "ws_session_duration": {
            "avg": 60438.7343269,
            "min": 60400.654,
            "med": 60410.790791499996,
            "max": 60678.240166,
            "p(90)": 60459.8384288,
            "p(95)": 60654.288291000004
        },
        "data_received": {
            "count": 31924150,
            "rate": 513065.64281162637
        },
        "vus": {
            "value": 10,
            "min": 10,
            "max": 20
        },
        "ws_msgs_sent": {
            "rate": 385.93849316202295,
            "count": 24014
        },
        "iteration_duration": {
            "med": 61022.043292,
            "max": 61246.192,
            "p(90)": 61167.6483414,
            "p(95)": 61243.15192115,
            "avg": 61008.9893999,
            "min": 60836.713333
        },
        "http_req_waiting": {
            "max": 520.042,
            "p(90)": 471.1645,
            "p(95)": 496.3973,
            "avg": 353.36809090909094,
            "min": 217.478,
            "med": 385.7605
        },
```

</details>

---

### smoke - 2026-01-31 12:05:37 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "metrics": {
        "data_received": {
            "count": 1047234,
            "rate": 17040.4725746306
        },
        "vus_max": {
            "value": 10,
            "min": 10,
            "max": 10
        },
        "iteration_duration": {
            "min": 1670.589416,
            "med": 1694.708375,
            "max": 2388.729625,
            "p(90)": 1725.203125,
            "p(95)": 2022.9776874999973,
            "avg": 1724.4421842507115
        },
        "checks": {
            "passes": 1755,
            "fails": 0,
            "thresholds": {
                "rate>0.95": false
            },
            "value": 1
        },
        "http_req_duration": {
            "p(90)": 281.5674,
            "p(95)": 291.9862,
            "avg": 236.76534377967735,
            "min": 198.175,
            "med": 210.681,
            "max": 976.862,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "http_req_blocked": {
            "med": 0.008,
            "max": 447.421,
            "p(90)": 0.011,
            "p(95)": 0.013,
            "avg": 4.168679012345667,
            "min": 0.001
        },
        "http_req_duration{expected_response:true}": {
            "max": 976.862,
            "p(90)": 281.5674,
            "p(95)": 291.9862,
            "avg": 236.76534377967735,
            "min": 198.175,
            "med": 210.681
        },
        "http_req_waiting": {
            "max": 976.706,
            "p(90)": 281.445,
            "p(95)": 291.8896,
            "avg": 236.6308964862296,
            "min": 198.113,
            "med": 210.528
        },
        "vus": {
            "value": 1,
            "min": 1,
            "max": 10
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 1053,
            "thresholds": {
                "rate<0.01": false
            },
            "value": 0
        },
        "http_req_sending": {
            "avg": 0.029427350427350382,
            "min": 0.004,
            "med": 0.029,
            "max": 0.399,
            "p(90)": 0.038,
            "p(95)": 0.045
        },
        "iterations": {
            "count": 351,
            "rate": 5.711432090340211
        },
        "http_req_tls_handshaking": {
            "p(90)": 0,
            "p(95)": 0,
            "avg": 0,
            "min": 0,
            "med": 0,
            "max": 0
        },
        "data_sent": {
            "count": 392418,
            "rate": 6385.3810770003565
        },
        "http_req_receiving": {
```

</details>

---

### room-creation - 2026-01-31 12:14:38 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "root_group": {
        "id": "d41d8cd98f00b204e9800998ecf8427e",
        "groups": {},
        "checks": {
                "room created": {
                    "fails": 0,
                    "name": "room created",
                    "path": "::room created",
                    "id": "fe4127567287937dd2f83625f48bd4d4",
                    "passes": 839
                },
                "room ended": {
                    "fails": 0,
                    "name": "room ended",
                    "path": "::room ended",
                    "id": "4c133d716191d4b40006ca3ab30e0220",
                    "passes": 839
                }
            },
        "name": "",
        "path": ""
    },
    "metrics": {
        "room_create_time": {
            "avg": 214.41835518474375,
            "min": 202,
            "med": 209,
            "max": 444,
            "p(90)": 215,
            "p(95)": 224,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "http_req_tls_handshaking": {
            "min": 0,
            "med": 0,
            "max": 0,
            "p(90)": 0,
            "p(95)": 0,
            "avg": 0
        },
        "http_req_sending": {
            "min": 0.007,
            "med": 0.034,
            "max": 0.277,
            "p(90)": 0.049,
            "p(95)": 0.053,
            "avg": 0.03424478856462173
        },
        "room_end_time": {
            "avg": 211.02860548271752,
            "min": 203,
            "med": 210,
            "max": 299,
            "p(90)": 217,
            "p(95)": 224
        },
        "http_req_connecting": {
            "min": 0,
            "med": 0,
            "max": 218.457,
            "p(90)": 0,
            "p(95)": 0,
            "avg": 2.557558665872543
        },
        "vus": {
            "value": 0,
            "min": 0,
            "max": 1
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 1679,
            "thresholds": {
                "rate<0.1": false
            },
            "value": 0
        },
        "checks": {
            "passes": 1678,
            "fails": 0,
            "value": 1
        },
        "iteration_duration": {
            "med": 420.0125,
            "max": 666.880209,
            "p(90)": 437.66608360000004,
            "p(95)": 452.652125,
            "avg": 425.705206707985,
            "min": 406.019833
        },
        "rooms_created": {
            "count": 839,
            "rate": 1.7451928569152362,
            "thresholds": {
                "count>500": false
            }
        },
```

</details>

---

### participant-churn - 2026-01-31 12:33:05 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "root_group": {
        "id": "d41d8cd98f00b204e9800998ecf8427e",
        "groups": {},
        "checks": {
                "participant added": {
                    "fails": 0,
                    "name": "participant added",
                    "path": "::participant added",
                    "id": "5778583306cac5bb605cb5048fe3e9cc",
                    "passes": 1477
                },
                "ws connected": {
                    "fails": 0,
                    "name": "ws connected",
                    "path": "::ws connected",
                    "id": "b890c791400ee254856ecce8133edded",
                    "passes": 1427
                }
            },
        "name": "",
        "path": ""
    },
    "metrics": {
        "http_req_duration{expected_response:true}": {
            "min": 203.988,
            "med": 214.2185,
            "max": 381.608,
            "p(90)": 225.2038,
            "p(95)": 228.891,
            "avg": 216.0411222972975
        },
        "vus_max": {
            "value": 100,
            "min": 100,
            "max": 100
        },
        "vus": {
            "max": 100,
            "value": 1,
            "min": 0
        },
        "data_sent": {
            "count": 2738062,
            "rate": 2616.401806798395
        },
        "checks": {
            "passes": 2904,
            "fails": 0,
            "value": 1
        },
        "join_latency": {
            "max": 674,
            "p(90)": 439,
            "p(95)": 446,
            "avg": 422.16384563303995,
            "min": 403,
            "med": 420,
            "thresholds": {
                "p(95)<2000": false
            }
        },
        "http_req_waiting": {
            "med": 214.0145,
            "max": 381.445,
            "p(90)": 225.06539999999998,
            "p(95)": 228.66375,
            "avg": 215.84064662162194,
            "min": 203.771
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 1480,
            "value": 0
        },
        "http_reqs": {
            "count": 1480,
            "rate": 1.4142392225090683
        },
        "http_req_tls_handshaking": {
            "med": 0,
            "max": 0,
            "p(90)": 0,
            "p(95)": 0,
            "avg": 0,
            "min": 0
        },
        "http_req_receiving": {
            "avg": 0.10604594594594598,
            "min": 0.024,
            "med": 0.097,
            "max": 2.368,
            "p(90)": 0.126,
            "p(95)": 0.149
        },
        "ws_sessions": {
            "rate": 1.4113725213823607,
            "count": 1477
        },
        "http_req_duration": {
```

</details>

---

### large-room - 2026-01-31 12:56:38 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "metrics": {
        "http_req_duration": {
            "p(90)": 228.4767,
            "p(95)": 232.86585,
            "avg": 217.99253550295853,
            "min": 204.653,
            "med": 215.155,
            "max": 335.167
        },
        "http_req_sending": {
            "med": 0.109,
            "max": 1.115,
            "p(90)": 0.16160000000000002,
            "p(95)": 0.18829999999999997,
            "avg": 0.11821893491124263,
            "min": 0.033
        },
        "vus": {
            "value": 2,
            "min": 0,
            "max": 150
        },
        "http_req_blocked": {
            "med": 204.75150000000002,
            "max": 441.877,
            "p(90)": 214.1847,
            "p(95)": 218.1055,
            "avg": 207.349852071006,
            "min": 0.014
        },
        "ws_connecting": {
            "med": 410.128875,
            "max": 907.846958,
            "p(90)": 427.0698125,
            "p(95)": 437.2883125,
            "avg": 413.83923126488105,
            "min": 396.160792
        },
        "ws_msgs_sent": {
            "count": 27240,
            "rate": 20.162933034895673
        },
        "http_req_duration{expected_response:true}": {
            "max": 335.167,
            "p(90)": 228.4767,
            "p(95)": 232.86585,
            "avg": 217.99253550295853,
            "min": 204.653,
            "med": 215.155
        },
        "broadcast_latency": {
            "min": 196,
            "med": 205,
            "max": 719,
            "p(90)": 213,
            "p(95)": 216,
            "avg": 205.62991345113596,
            "thresholds": {
                "p(95)<500": false,
                "p(99)<1000": false
            }
        },
        "http_req_waiting": {
            "med": 214.9565,
            "max": 335.033,
            "p(90)": 228.2787,
            "p(95)": 232.6503,
            "avg": 217.75433136094682,
            "min": 204.531
        },
        "vus_max": {
            "value": 150,
            "min": 150,
            "max": 150
        },
        "iteration_duration": {
            "med": 600833.880042,
            "max": 601332.53725,
            "p(90)": 600858.340896,
            "p(95)": 600869.936333,
            "avg": 600840.0801192906,
            "min": 600807.047042
        },
        "iterations": {
            "count": 196,
            "rate": 0.14507837279146665
        },
        "http_req_tls_handshaking": {
            "p(90)": 0,
            "p(95)": 0,
            "avg": 0,
            "min": 0,
            "med": 0,
            "max": 0
        },
        "data_received": {
            "count": 255912744,
            "rate": 189425.53304142435
        },
```

</details>

---

### ws-storm - 2026-01-31 13:02:44 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 0 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 0 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 0 | - |
| Checks Failed | 0 | 0 |

<details>
<summary>Raw Output</summary>

```
{
    "setup_data": {
        "roomId": "70e01a93-8002-4072-9134-decbbf0b1773",
        "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJjaGFsayIsInN1YiI6ImYyZDI5YmIwLWE3ODYtNDIxNy05YThjLThmOThhODMwZjZlNSIsImV4cCI6MTc2OTg2Nzg1OSwiaWF0IjoxNzY5ODY0MjU5LCJqdGkiOiJLVlRBeGh6dGl3MlZyZWVydmZ0NEJ3IiwidGVuYW50X2lkIjoiZjJkMjliYjAtYTc4Ni00MjE3LTlhOGMtOGY5OGE4MzBmNmU1Iiwicm9vbV9pZCI6IjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMCIsInBlcm1pc3Npb25zIjp7ImNhbl9yZWNvcmQiOnRydWUsImNhbl9zY3JlZW5fc2hhcmUiOnRydWUsImNhbl9raWNrIjp0cnVlLCJjYW5fbXV0ZSI6dHJ1ZX0sInR5cGUiOiJhY2Nlc3MifQ.qMAMSuFo84bP9kSVyW86r5dqLCUIi5rF9P9xmIUOtHA"
    },
    "root_group": {
        "name": "",
        "path": "",
        "id": "d41d8cd98f00b204e9800998ecf8427e",
        "groups": {},
        "checks": {
                "ws connected": {
                    "fails": 0,
                    "name": "ws connected",
                    "path": "::ws connected",
                    "id": "b890c791400ee254856ecce8133edded",
                    "passes": 250
                }
            }
    },
    "metrics": {
        "http_req_blocked": {
            "med": 206.5735,
            "max": 425.197,
            "p(90)": 215.558,
            "p(95)": 218.56985,
            "avg": 207.00272222222225,
            "min": 0.01
        },
        "vus_max": {
            "value": 50,
            "min": 50,
            "max": 50
        },
        "http_req_receiving": {
            "avg": 0.11252380952380953,
            "min": 0.029,
            "med": 0.0765,
            "max": 2.593,
            "p(90)": 0.142,
            "p(95)": 0.18239999999999987
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 252,
            "value": 0
        },
        "data_received": {
            "count": 991163037,
            "rate": 3240780.73358553
        },
        "ws_msgs_sent": {
            "count": 300147,
            "rate": 981.3830606391913
        },
        "http_req_duration{expected_response:true}": {
            "p(95)": 845.15815,
            "avg": 311.13650396825386,
            "min": 204.886,
            "med": 218.6745,
            "max": 923.488,
            "p(90)": 812.7573
        },
        "http_req_duration": {
            "max": 923.488,
            "p(90)": 812.7573,
            "p(95)": 845.15815,
            "avg": 311.13650396825386,
            "min": 204.886,
            "med": 218.6745
        },
        "http_req_sending": {
            "max": 0.507,
            "p(90)": 0.117,
            "p(95)": 0.14279999999999995,
            "avg": 0.07680952380952384,
            "min": 0.026,
            "med": 0.065
        },
        "vus": {
            "min": 50,
            "max": 50,
            "value": 50
        },
        "iteration_duration": {
            "p(90)": 61445.410058400004,
            "p(95)": 61465.4054035,
            "avg": 60932.561545011966,
            "min": 60807.924416,
            "med": 60841.578479,
            "max": 61539.006542
        },
        "http_req_waiting": {
            "avg": 310.94717063492084,
            "min": 204.622,
            "med": 218.565,
            "max": 923.375,
            "p(90)": 812.629,
            "p(95)": 845.062
        },
```

</details>

---

### smoke - 2026-01-31 13:38:13 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 1059 | - |
| Error Rate | 0.0000 | - |
| p95 Latency | 293 ms | - |
| p99 Latency | 0 ms | - |
| Checks Passed | 1765 | - |
| Checks Failed | 0 | - |
| Rooms Created | 0 | - |
| Participant Joins | 0 | - |
| Participants Joined | 0 | - |
| Broadcast p95 | 0 ms | - |
| WS Msgs Sent (rate) | 0.00/s | - |
| WS Msgs Recv (rate) | 0.00/s | - |
| Messages Attempted | 0 | - |
| Message Error Rate | 0.0000 | - |

<details>
<summary>Raw Output</summary>

```
{
    "metrics": {
        "http_req_connecting": {
            "p(95)": 0,
            "avg": 1.9400406043437202,
            "min": 0,
            "med": 0,
            "max": 212.824,
            "p(90)": 0
        },
        "checks": {
            "passes": 1765,
            "fails": 0,
            "thresholds": {
                "rate>0.95": false
            },
            "value": 1
        },
        "http_req_failed": {
            "passes": 0,
            "fails": 1059,
            "thresholds": {
                "rate<0.01": false
            },
            "value": 0
        },
        "http_req_sending": {
            "med": 0.028,
            "max": 0.899,
            "p(90)": 0.039,
            "p(95)": 0.044,
            "avg": 0.029768649669499447,
            "min": 0.005
        },
        "http_req_duration{expected_response:true}": {
            "med": 211.142,
            "max": 539.17,
            "p(90)": 282.9366,
            "p(95)": 293.3659,
            "avg": 235.38641359773382,
            "min": 198.014
        },
        "vus": {
            "min": 3,
            "max": 10,
            "value": 3
        },
        "iterations": {
            "count": 353,
            "rate": 5.747874328605943
        },
        "http_req_receiving": {
            "max": 0.309,
            "p(90)": 0.143,
            "p(95)": 0.15509999999999996,
            "avg": 0.09702738432483464,
            "min": 0.011,
            "med": 0.092
        },
        "http_req_blocked": {
            "avg": 4.140541076487266,
            "min": 0.001,
            "med": 0.008,
            "max": 444.771,
            "p(90)": 0.012,
            "p(95)": 0.013
        },
        "vus_max": {
            "min": 10,
            "max": 10,
            "value": 10
        },
        "http_req_duration": {
            "p(90)": 282.9366,
            "p(95)": 293.3659,
            "avg": 235.38641359773382,
            "min": 198.014,
            "med": 211.142,
            "max": 539.17,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "http_reqs": {
            "count": 1059,
            "rate": 17.24362298581783
        },
        "iteration_duration": {
            "min": 1670.471792,
            "med": 1697.065584,
            "max": 2429.4555,
            "p(90)": 1729.4707672,
            "p(95)": 1767.555267,
            "avg": 1720.2201337507083
        },
        "data_received": {
            "count": 1053219,
            "rate": 17149.491366855586
        },
        "data_sent": {
```

</details>

---

### smoke - 2026-01-31 14:30:58 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 1053 | - |
| Error Rate | 0.0000 | - |
| p95 Latency | 308 ms | - |
| p99 Latency | 0 ms | - |
| Checks Passed | 1755 | - |
| Checks Failed | 0 | - |
| Rooms Created | 0 | - |
| Participant Joins | 0 | - |
| Participants Joined | 0 | - |
| Broadcast p95 | 0 ms | - |
| WS Msgs Sent (rate) | 0.00/s | - |
| WS Msgs Recv (rate) | 0.00/s | - |
| Messages Attempted | 0 | - |
| Message Error Rate | 0.0000 | - |

<details>
<summary>Raw Output</summary>

```
{
    "metrics": {
        "http_req_sending": {
            "avg": 0.012690408357074969,
            "min": 0.004,
            "med": 0.011,
            "max": 0.101,
            "p(90)": 0.018,
            "p(95)": 0.023
        },
        "http_req_duration{expected_response:true}": {
            "med": 211.765,
            "max": 744.896,
            "p(90)": 284.8152,
            "p(95)": 307.54959999999994,
            "avg": 240.88405603038976,
            "min": 197.608
        },
        "http_req_blocked": {
            "avg": 4.182254510921251,
            "min": 0.001,
            "med": 0.003,
            "max": 449.233,
            "p(90)": 0.005,
            "p(95)": 0.006
        },
        "vus": {
            "value": 4,
            "min": 4,
            "max": 10
        },
        "vus_max": {
            "value": 10,
            "min": 10,
            "max": 10
        },
        "http_req_duration": {
            "min": 197.608,
            "med": 211.765,
            "max": 744.896,
            "p(90)": 284.8152,
            "p(95)": 307.54959999999994,
            "avg": 240.88405603038976,
            "thresholds": {
                "p(95)<1000": false
            }
        },
        "http_reqs": {
            "count": 1053,
            "rate": 17.159340725418705
        },
        "http_req_receiving": {
            "p(90)": 0.071,
            "p(95)": 0.084,
            "avg": 0.047745489078822236,
            "min": 0.009,
            "med": 0.041,
            "max": 1.118
        },
        "data_received": {
            "count": 1047573,
            "rate": 17070.90412321847
        },
        "data_sent": {
            "count": 392418,
            "rate": 6394.714310339371
        },
        "http_req_connecting": {
            "min": 0,
            "med": 0,
            "max": 215.078,
            "p(90)": 0,
            "p(95)": 0,
            "avg": 1.9540902184235518
        },
        "http_req_tls_handshaking": {
            "avg": 0,
            "min": 0,
            "med": 0,
            "max": 0,
            "p(90)": 0,
            "p(95)": 0
        },
        "http_req_waiting": {
            "med": 211.706,
            "max": 744.836,
            "p(90)": 284.76779999999997,
            "p(95)": 307.49899999999997,
            "avg": 240.82362013295335,
            "min": 197.555
        },
        "checks": {
            "fails": 0,
            "passes": 1755,
            "thresholds": {
                "rate>0.95": false
            },
            "value": 1
        },
        "iteration_duration": {
```

</details>

---

### large-room - 2026-02-03 10:05:13 UTC

**Status**: ✅ PASS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | 456 | - |
| Error Rate | 0.0000 | < 0.01 |
| p95 Latency | 1659 ms | < 2000 ms |
| p99 Latency | 0 ms | < 5000 ms |
| Checks Passed | 270 | - |
| Checks Failed | 0 | 0 |
| Rooms Created | 0 | - |
| Participant Joins | 0 | - |
| Participants Joined | 454 | - |
| Broadcast p95 | 293 ms | - |
| WS Msgs Sent (rate) | 27.29/s | - |
| WS Msgs Recv (rate) | 4157.72/s | - |
| Messages Attempted | 0 | - |
| Message Error Rate | 0.0000 | - |

<details>
<summary>Raw Output</summary>

```
{
    "root_group": {
        "path": "",
        "id": "d41d8cd98f00b204e9800998ecf8427e",
        "groups": {},
        "checks": {
                "ws connected": {
                    "name": "ws connected",
                    "path": "::ws connected",
                    "id": "b890c791400ee254856ecce8133edded",
                    "passes": 270,
                    "fails": 0
                }
            },
        "name": ""
    },
    "metrics": {
        "http_req_failed": {
            "passes": 0,
            "fails": 456,
            "value": 0
        },
        "http_req_connecting": {
            "p(95)": 223.55175,
            "avg": 211.38830482456154,
            "min": 0,
            "med": 210.041,
            "max": 246.363,
            "p(90)": 221.5075
        },
        "ws_connecting": {
            "med": 423.3440625,
            "max": 689.474833,
            "p(90)": 467.49480370000003,
            "p(95)": 495.8935374,
            "avg": 434.8879831343611,
            "min": 404.0625
        },
        "http_req_waiting": {
            "p(90)": 1375.026,
            "p(95)": 1658.6889999999994,
            "avg": 1122.1565263157897,
            "min": 738.865,
            "med": 1025.9055,
            "max": 3815.204
        },
        "http_req_receiving": {
            "min": 0.031,
            "med": 0.088,
            "max": 2.63,
            "p(90)": 0.19150000000000003,
            "p(95)": 0.30449999999999994,
            "avg": 0.14142105263157898
        },
        "ws_session_duration": {
            "avg": 600434.6024147774,
            "min": 600406.344625,
            "med": 600422.8751875,
            "max": 600689.965625,
            "p(90)": 600476.1563417,
            "p(95)": 600497.5726997
        },
        "vus": {
            "value": 1,
            "min": 0,
            "max": 200
        },
        "broadcast_latency": {
            "avg": 231.59320284934424,
            "min": 201,
            "med": 218,
            "max": 1058,
            "p(90)": 274,
            "p(95)": 293,
            "thresholds": {
                "p(95)<500": false,
                "p(99)<1000": false
            }
        },
        "http_req_sending": {
            "max": 1.307,
            "p(90)": 0.143,
            "p(95)": 0.168,
            "avg": 0.09360745614035078,
            "min": 0.023,
            "med": 0.0755
        },
        "participants_joined": {
            "count": 454,
            "rate": 0.33571440996981583,
            "thresholds": {
                "count>120": false
            }
        },
        "data_sent": {
            "count": 3692175,
            "rate": 2730.2122282605833
        },
        "http_req_duration{expected_response:true}": {
            "avg": 1122.3915548245623,
```

</details>

---
