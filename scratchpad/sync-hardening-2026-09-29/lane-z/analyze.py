"""Analyze the two same-M4 sanitized arms; never treat censoring as zero."""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCENARIOS = ('drop-5000', 'flapping', 'sync-restart')


def stats(values):
    values = sorted(x for x in values if isinstance(x, (int, float)) and math.isfinite(x))
    n = len(values)
    return {'n': n, 'p50': (values[(n-1)//2] + values[n//2])/2 if n else None,
            'p95': values[math.ceil(.95*n)-1] if n else None,
            'max': values[-1] if n else None}


def four_media(row):
    values = [row['mediaReturnMs'][direction][kind]
              for direction in ('aToB', 'bToA') for kind in ('audioMs', 'videoMs')]
    return max(values) if all(isinstance(value, (int, float)) for value in values) else None


def summarize(rows):
    valid = [row for row in rows if row['setupOk'] and row['initialMediaOk'] and row['scenarioCompleted']]
    output = {'eligible': len(valid), 'attempts': len(rows), 'ineligible': len(rows)-len(valid)}
    metrics = {'sync': lambda row: row['syncReconnectMs'],
               'state': lambda row: row['convergenceMs'],
               'mediaAllFour': four_media,
               'actionsSettled': lambda row: row['actions']['settledMs'],
               'noticeAfterDetection': lambda row: row['reconnectingAfterDetectionMs'],
               'noticeFromFault': lambda row: row['reconnectingMs'],
               'postgresDown': lambda row: row.get('postgresDownDurationMs'),
               'flapCount': lambda row: row.get('dropCount')}
    output['metrics'] = {key: stats(fn(row) for row in valid) for key, fn in metrics.items()}
    output['directions'] = {direction: {kind: stats(row['mediaReturnMs'][direction][kind] for row in valid)
                                        for kind in ('audioMs', 'videoMs')}
                            for direction in ('aToB', 'bToA')}
    output['pending'] = sum(row['actions']['attempted'] and not all(
        row['actions'][kind + 'Outcome'] in ('resolved', 'rejected')
        for kind in ('chat', 'hand')) for row in valid)
    output['lost'] = sum(row['actions']['chatLost'] or row['actions']['handLost'] for row in valid)
    output['duplicated'] = sum(row['actions']['chatDuplicated'] or row['actions']['handDuplicated'] for row in valid)
    output['terminalFailed'] = sum(row.get('terminalFailed', False) for row in valid)
    output['continuousFourWayMedia'] = sum(row['mediaFlowingAtRestore'] for row in valid)
    output['stateConverged'] = sum(row['state']['converged'] for row in valid)
    output['actionOutcomes'] = {kind+'_'+outcome: sum(row['actions'][kind+'Outcome'] == outcome for row in valid)
                                for kind in ('chat', 'hand') for outcome in ('resolved', 'rejected', 'pending')}
    output['networkQualification'] = {
        'aRttMedianMs': stats(row['networkObserved']['rttMs']['p50'] for row in valid),
        'bInboundPacketLossPct': stats(row['networkObservedB']['inboundPacketLossPct'] for row in valid),
    }
    output['hostLoadOneMinute'] = stats(row['hostLoadStart'][0] for row in valid if row['hostLoadStart'])
    output['failures'] = [{'run': row['run'], 'errors': row['failures']} for row in valid if row['failures']]
    output['ineligibleReasons'] = [{'run': row['run'], 'errors': row['failures'], 'harnessErrors': row['harnessFailures']} for row in rows if row not in valid]
    return output


result = {'machine': 'same M4 Mac mini', 'baselineSha': '3a77a9fbb8d545f876d75f6a25e5d1021e45924c',
          'tipSha': 'a5448d5fa3313b98efd5b91ffe72ffa7777c3c27',
          'metricDefinition': 'milliseconds; p50 median, p95 nearest-rank; missing is censored, not zero',
          'scenarios': {}}
for scenario in SCENARIOS:
    result['scenarios'][scenario] = {}
    for arm in ('a', 'b'):
        path = ROOT/'results-m4'/arm/(scenario+'.jsonl')
        rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        result['scenarios'][scenario][arm] = summarize(rows)


def metric_pass(metric, expected, p95, maximum):
    return metric['n'] == expected and metric['p95'] <= p95 and metric['max'] <= maximum


for scenario, arms in result['scenarios'].items():
    for arm, value in arms.items():
        criteria = {}
        m = value['metrics']
        clean_actions = value['pending'] == value['lost'] == value['duplicated'] == 0
        expected = 5 if scenario == 'sync-restart' else 10
        if value['eligible'] == expected:
            if scenario == 'drop-5000':
                criteria = {'sync': metric_pass(m['sync'], expected, 2000, 5000),
                            'state': metric_pass(m['state'], expected, 2000, 5000),
                            'media': metric_pass(m['mediaAllFour'], expected, 3000, 5000),
                            'reconnectingFromFault': arm == 'a' or metric_pass(m['noticeFromFault'], expected, 1000, 1000),
                            'acknowledgedActions': clean_actions}
            elif scenario == 'flapping':
                criteria = {'sync': metric_pass(m['sync'], expected, 5000, 5000),
                            'state': metric_pass(m['state'], expected, 5000, 5000),
                            'media': metric_pass(m['mediaAllFour'], expected, 5000, 5000),
                            'noTerminalFailed': value['terminalFailed'] == 0,
                            'actions': clean_actions}
            elif scenario == 'sync-restart':
                criteria = {'sync': metric_pass(m['sync'], expected, 5000, 10000), 'actions': clean_actions}
        criteria['noFailures'] = not value['failures']
        value['target'] = 'unproven' if value['eligible'] != expected else ('met' if all(criteria.values()) else 'missed')
        value['targetCriteria'] = criteria

NOISE_MS = {'sync': 500, 'state': 500, 'mediaAllFour': 1000, 'actionsSettled': 500}
result['parity'] = {}
for scenario, arms in result['scenarios'].items():
    expected = 5 if scenario == 'sync-restart' else 10
    paired = {}
    for metric, noise in NOISE_MS.items():
        baseline = arms['a']['metrics'][metric]
        tip = arms['b']['metrics'][metric]
        complete = baseline['n'] == tip['n'] == expected
        deltas = {kind: tip[kind] - baseline[kind] if complete else None for kind in ('p95', 'max')}
        paired[metric] = {'noiseMs': noise, 'deltaMs': deltas,
                          'withinNoise': complete and all(delta <= noise for delta in deltas.values())}
    paired['sameActionOutcomes'] = arms['a']['actionOutcomes'] == arms['b']['actionOutcomes']
    paired['noNewLossDuplicationOrFailure'] = all(
        arms['b'][key] <= arms['a'][key] for key in ('pending', 'lost', 'duplicated', 'terminalFailed')) and not arms['b']['failures']
    paired['recoveryParity'] = (all(paired[key]['withinNoise'] for key in NOISE_MS)
                                and paired['sameActionOutcomes'] and paired['noNewLossDuplicationOrFailure'])
    result['parity'][scenario] = paired

(ROOT/'analysis-m4.json').write_text(json.dumps(result, indent=2)+'\n')


def cell(metric):
    if not metric['n']:
        return 'n=0; censored'
    return f"n={metric['n']}; " + '/'.join(f"{metric[key]/1000:.3f}" for key in ('p50', 'p95', 'max'))


lines = ['# Same-M4 matched comparison', '', 'Seconds; n; p50/p95/max. A and B are interleaved per scenario. Censored outcomes never count as zero.', '',
         '| Scenario | Arm | Eligible/attempts | Sync | State + outcomes | Four media directions | Action terminal outcome | Target |',
         '|---|---|---:|---|---|---|---|---|']
for scenario, arms in result['scenarios'].items():
    for arm, value in arms.items():
        lines.append('| ' + ' | '.join([scenario, arm.upper(), f"{value['eligible']}/{value['attempts']}"] +
                    [cell(value['metrics'][key]) for key in ('sync', 'state', 'mediaAllFour', 'actionsSettled')] +
                    [value['target']]) + ' |')
lines += ['', 'Predeclared p95/max noise: Sync, state+outcomes, and actions ≤0.500 s; worst four-way media ≤1.000 s. Negative deltas favor B.', '',
          '| Scenario | Metric | B − A p95 / max (s) | Bound (s) | Within noise |',
          '|---|---|---:|---:|---|']
for scenario, paired in result['parity'].items():
    for metric in NOISE_MS:
        value = paired[metric]
        deltas = value['deltaMs']
        delta_cell = 'censored' if deltas['p95'] is None else f"{deltas['p95']/1000:+.3f} / {deltas['max']/1000:+.3f}"
        lines.append(f"| {scenario} | {metric} | {delta_cell} | {value['noiseMs']/1000:.3f} | {'yes' if value['withinNoise'] else 'no'} |")
(ROOT/'comparison-m4.md').write_text('\n'.join(lines)+'\n')
print('\n'.join(lines))
