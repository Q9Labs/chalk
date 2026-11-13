#!/usr/bin/env python3
"""Show where one workflow run spent its wall time: each job's wait for a runner and its work, and the chain of jobs that set the end time.

usage: cut_timing.py <run-id> [--until <part of a job name>]
       cut_timing.py --file <saved.json> [--until <part of a job name>]
"""
import argparse
import json
import os
import subprocess
from datetime import datetime

# A job is created the moment its last `needs` job completes; allow for clock rounding.
SLACK_SECONDS = 2


def moment(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def minutes(start, end):
    return (end - start).total_seconds() / 60


def timings(started, jobs):
    """One row per job that has finished, with minutes counted from the run's start."""
    rows = []
    for job in jobs:
        if not job.get('completed_at') or not job.get('started_at'):
            continue
        created, begun, ended = (moment(job[key]) for key in ('created_at', 'started_at', 'completed_at'))
        rows.append(dict(name=job['name'], created=created, ended=ended, at=minutes(started, created), wait=minutes(created, begun),
                         work=minutes(begun, ended), end=minutes(started, ended)))
    return sorted(rows, key=lambda row: row['created'])


def critical_path(rows, until):
    """The jobs that gated `until`, found backwards: each one was released by the latest job that ended before it was created."""
    ends = [row for row in rows if until in row['name']]
    if not ends:
        raise ValueError(f'no finished job matches {until!r}')
    path = [max(ends, key=lambda row: row['ended'])]
    while True:
        earlier = [row for row in rows if row is not path[-1] and (path[-1]['created'] - row['ended']).total_seconds() >= -SLACK_SECONDS]
        if not earlier:
            return path[::-1]
        path.append(max(earlier, key=lambda row: row['ended']))


def report(run_started, jobs, until):
    rows = timings(moment(run_started), jobs)
    path = critical_path(rows, until)
    lines = [f'{"job":58} {"created":>8} {"wait":>6} {"work":>6}   (minutes after the run started)']
    lines += [f'{row["name"][:58]:58} {row["at"]:8.1f} {row["wait"]:6.1f} {row["work"]:6.1f}' for row in rows]
    work, wait = sum(row['work'] for row in path), sum(row['wait'] for row in path)
    lines += ['', f'Path to {path[-1]["name"]!r}, which ended {path[-1]["end"]:.1f} minutes after the run started:']
    lines += [f'  {row["name"][:58]:58} wait {row["wait"]:5.1f}  work {row["work"]:5.1f}' for row in path]
    lines.append(f'  total wait {wait:.1f}, total work {work:.1f}')
    return '\n'.join(lines)


def fetch(run_id):
    repository = os.environ.get('GITHUB_REPOSITORY', 'Q9Labs/chalk')

    def read(route):
        return json.loads(subprocess.check_output(['gh', 'api', f'repos/{repository}/actions/{route}'], text=True))
    run = read(f'runs/{run_id}')
    return dict(run_started_at=run['run_started_at']), read(f'runs/{run_id}/jobs?per_page=100&filter=latest')['jobs']


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('run_id', nargs='?')
    parser.add_argument('--file', help='a saved {"run": {"run_started_at": ...}, "jobs": [...]}')
    parser.add_argument('--until', default='record', help='part of the name of the job that ends the path; default: record')
    args = parser.parse_args()
    if args.file:
        with open(args.file) as saved:
            data = json.load(saved)
        run, jobs = data['run'], data['jobs']
    elif args.run_id:
        run, jobs = fetch(args.run_id)
    else:
        parser.error('give a run id or --file')
    print(report(run['run_started_at'], jobs, args.until))


if __name__ == '__main__':
    main()
