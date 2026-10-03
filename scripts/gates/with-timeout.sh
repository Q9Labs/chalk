#!/usr/bin/env bash
# Runs a command under a time limit. macOS has no GNU timeout, so perl (always present) enforces it.
# Usage: with-timeout.sh <seconds> <label> -- <command> [args...]
# On expiry the command's process group gets TERM, then KILL after 10 seconds, and this exits 124.
set -euo pipefail

if (($# < 4)) || [[ "$3" != "--" ]]; then
  echo "usage: with-timeout.sh <seconds> <label> -- <command> [args...]" >&2
  exit 2
fi
seconds="$1"
label="$2"
shift 3

exec perl -e '
  my ($seconds, $label, @command) = @ARGV;
  my $pid = fork();
  die "fork failed: $!" unless defined $pid;
  if ($pid == 0) { setpgrp(0, 0); exec @command or do { print STDERR "cannot run $command[0]: $!\n"; exit 127 } }
  my $timed_out = 0;
  $SIG{ALRM} = sub {
    $timed_out = 1;
    print STDERR "\nTIMEOUT: \"$label\" exceeded ${seconds}s and was stopped; it hung or ran far longer than expected\n";
    kill "TERM", -$pid;
    $SIG{ALRM} = sub { kill "KILL", -$pid };
    alarm 10;
  };
  $SIG{TERM} = $SIG{INT} = sub { kill "TERM", -$pid };
  alarm $seconds;
  my $done;
  do { $done = waitpid($pid, 0) } while ($done == -1 && $!{EINTR});
  alarm 0;
  exit 124 if $timed_out;
  exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
' -- "${seconds}" "${label}" "$@"
