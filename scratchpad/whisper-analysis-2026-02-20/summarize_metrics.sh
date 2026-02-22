#!/usr/bin/env bash
set -euo pipefail
D=scratchpad/whisper-analysis-2026-02-20/metrics

completed_total=$(jq '[.Datapoints[]|.Sum] | add // 0' "$D/transcriptions_completed_daily.json")
failed_total=$(jq '[.Datapoints[]|.Sum] | add // 0' "$D/transcriptions_failed_daily.json")
total_total=$(jq '[.Datapoints[]|.Sum] | add // 0' "$D/transcriptions_total_daily.json")
days_with_data=$(jq '.Datapoints|length' "$D/transcriptions_total_daily.json")
peak_day=$(jq -r '.Datapoints|sort_by(.Sum)|last|[.Timestamp,.Sum]|@tsv' "$D/transcriptions_completed_daily.json")

qdepth_max=$(jq '[.Datapoints[]|.Maximum] | max // 0' "$D/queue_depth_daily.json")
qdepth_avg=$(jq '[.Datapoints[]|.Average] | add/length' "$D/queue_depth_daily.json")

qwait_p95_med=$(jq '[.Datapoints[]|.ExtendedStatistics.p95] | sort | .[(length*0.5|floor)]' "$D/queue_wait_daily.json")
qwait_p95_max=$(jq '[.Datapoints[]|.ExtendedStatistics.p95] | max // 0' "$D/queue_wait_daily.json")

ptime_p50_med=$(jq '[.Datapoints[]|.ExtendedStatistics.p50] | sort | .[(length*0.5|floor)]' "$D/processing_time_daily.json")
ptime_p95_med=$(jq '[.Datapoints[]|.ExtendedStatistics.p95] | sort | .[(length*0.5|floor)]' "$D/processing_time_daily.json")
ptime_p95_max=$(jq '[.Datapoints[]|.ExtendedStatistics.p95] | max // 0' "$D/processing_time_daily.json")

aduration_p50_med_ms=$(jq '[.Datapoints[]|.ExtendedStatistics.p50] | sort | .[(length*0.5|floor)]' "$D/transcription_duration_daily.json")
aduration_p95_med_ms=$(jq '[.Datapoints[]|.ExtendedStatistics.p95] | sort | .[(length*0.5|floor)]' "$D/transcription_duration_daily.json")

# 10m burst stats
burst_10m_max=$(jq '[.Datapoints[]|.Sum] | max // 0' "$D/transcriptions_completed_10m.json")
burst_10m_p95=$(jq '[.Datapoints[]|.Sum] | sort | .[(length*0.95|floor)] // 0' "$D/transcriptions_completed_10m.json")
qdepth_10m_max=$(jq '[.Datapoints[]|.Maximum] | max // 0' "$D/queue_depth_10m.json")
qwait_10m_p95_max=$(jq '[.Datapoints[]|.ExtendedStatistics.p95] | max // 0' "$D/queue_wait_10m.json")

cpu_avg=$(jq '[.Datapoints[]|.Average] | add/length' "$D/ec2_cpu_10m_asg.json")
cpu_p95=$(jq '[.Datapoints[]|.Average] | sort | .[(length*0.95|floor)]' "$D/ec2_cpu_10m_asg.json")
cpu_max=$(jq '[.Datapoints[]|.Maximum] | max // 0' "$D/ec2_cpu_10m_asg.json")

success_rate=$(awk -v c="$completed_total" -v t="$total_total" 'BEGIN{if(t==0){print 0}else{printf "%.4f", (c/t)*100}}')
rtf_p50=$(awk -v p="$ptime_p50_med" -v d="$aduration_p50_med_ms" 'BEGIN{if(d==0){print 0}else{printf "%.4f", p/(d/1000)}}')
rtf_p95=$(awk -v p="$ptime_p95_med" -v d="$aduration_p95_med_ms" 'BEGIN{if(d==0){print 0}else{printf "%.4f", p/(d/1000)}}')

cat <<TXT
completed_total=$completed_total
failed_total=$failed_total
total_total=$total_total
success_rate_percent=$success_rate
days_with_data=$days_with_data
peak_day=$peak_day

queue_depth_daily_max=$qdepth_max
queue_depth_daily_avg=$qdepth_avg
queue_wait_daily_p95_median_ms=$qwait_p95_med
queue_wait_daily_p95_max_ms=$qwait_p95_max

processing_time_daily_p50_median_s=$ptime_p50_med
processing_time_daily_p95_median_s=$ptime_p95_med
processing_time_daily_p95_max_s=$ptime_p95_max

audio_duration_daily_p50_median_ms=$aduration_p50_med_ms
audio_duration_daily_p95_median_ms=$aduration_p95_med_ms

rtf_p50_est=$rtf_p50
rtf_p95_est=$rtf_p95

throughput_10m_peak_jobs=$burst_10m_max
throughput_10m_p95_jobs=$burst_10m_p95
queue_depth_10m_peak=$qdepth_10m_max
queue_wait_10m_p95_peak_ms=$qwait_10m_p95_max

ec2_cpu_avg_percent=$cpu_avg
ec2_cpu_p95_percent=$cpu_p95
ec2_cpu_max_percent=$cpu_max
TXT
