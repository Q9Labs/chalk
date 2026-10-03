"""Analyze content-free ingress rows; no media or stable payload hashes required."""
import collections
import json
import pathlib
import sys


def analyze(path):
    counts = collections.Counter()
    seen = {}
    admitted_seen = set()
    pictures = collections.defaultdict(set)
    admitted_pictures = collections.defaultdict(set)
    last = {}
    admitted_last = {}
    sequences = {}
    primary = collections.defaultdict(set)
    admitted = collections.defaultdict(set)
    rtx_admitted = collections.defaultdict(set)
    first_arrival = None
    last_arrival = None
    for line in path.open():
        row = json.loads(line)
        counts['packets'] += 1
        counts[row['outcome']] += 1
        counts['rtx_packets'] += row['rtx_ssrc'] is not None
        ssrc = row['ssrc']
        sequence = row['sequence']
        highest = sequences.get(ssrc, sequence)
        extended = highest + ((sequence - (highest & 65535) + 32768) % 65536) - 32768
        sequences[ssrc] = max(highest, extended)
        if row['rtx_ssrc'] is None and row['outcome'] != 'measurement_boundary':
            primary[ssrc].add(extended)
        if row['admitted']:
            admitted[ssrc].add(extended)
            if row['rtx_ssrc'] is not None:
                rtx_admitted[ssrc].add(extended)
        first_arrival = row['arrival_ns'] if first_arrival is None else first_arrival
        last_arrival = row['arrival_ns']
        if not row['payload_bytes']:
            counts['empty_packets'] += 1
            continue
        counts['video_packets'] += 1
        kind = 'rtx' if row['rtx_ssrc'] is not None else 'primary'
        counts[kind + '_video_packets'] += 1
        fingerprint = (ssrc, row['fingerprint'])
        counts['ingress_repeats'] += fingerprint in seen
        counts[kind + '_repeats'] += fingerprint in seen
        if fingerprint in seen:
            previous_sequence, previous_timestamp = seen[fingerprint]
            counts['repeats_changed_sequence'] += row['sequence'] != previous_sequence
            counts['repeats_changed_timestamp'] += row['timestamp'] != previous_timestamp
        else:
            seen[fingerprint] = (row['sequence'], row['timestamp'])
        timestamp = row['timestamp']
        previous = last.get(ssrc, timestamp)
        counts['ingress_regressions'] += (timestamp - previous + 2**31) % 2**32 - 2**31 < 0
        last[ssrc] = timestamp
        if row['picture_id'] is not None:
            pictures[(ssrc, timestamp)].add(row['picture_id'])
        if row['admitted']:
            counts['admitted_video_packets'] += 1
            counts['admitted_repeats'] += fingerprint in admitted_seen
            admitted_seen.add(fingerprint)
            previous = admitted_last.get(ssrc, timestamp)
            counts['admitted_regressions'] += (timestamp - previous + 2**31) % 2**32 - 2**31 < 0
            admitted_last[ssrc] = timestamp
            counts['negative_offsets'] += row['negative_offset']
            if row['picture_id'] is not None:
                admitted_pictures[(ssrc, timestamp)].add(row['picture_id'])
    counts['conflicting_buckets'] = sum(len(ids) > 1 for ids in pictures.values())
    counts['admitted_conflicting_buckets'] = sum(len(ids) > 1 for ids in admitted_pictures.values())
    for ssrc, positions in primary.items():
        expected = set(range(min(positions), max(positions) + 1))
        gaps = expected - positions
        counts['primary_sequence_span'] += len(expected)
        counts['primary_missing_positions'] += len(gaps)
        counts['rtx_repaired_positions'] += len(gaps & rtx_admitted[ssrc])
        counts['unrepaired_positions'] += len(expected - admitted[ssrc])
    result = dict(counts)
    result['seconds'] = (last_arrival - first_arrival) / 1e9 if first_arrival is not None else 0
    result['unrepaired_fraction'] = counts['unrepaired_positions'] / counts['primary_sequence_span'] if counts['primary_sequence_span'] else None
    return result


if __name__ == '__main__':
    directory = pathlib.Path(sys.argv[1])
    print(json.dumps({policy: analyze(directory / (policy + '.jsonl')) for policy in ('omitted', 'explicit')}, indent=2))
