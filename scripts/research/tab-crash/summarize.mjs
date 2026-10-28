import { readFile, writeFile } from 'node:fs/promises';
const input=process.argv[2], destination=process.argv[3] ?? '.';
if(!input)throw new Error('Usage: node summarize.mjs measurements.json output-directory');
const rows=JSON.parse(await readFile(input,'utf8'));
const runs=[...new Set(rows.map(row=>row.run))];
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];};
const f=value=>Number(value).toFixed(1);
const range=values=>`${f(Math.min(...values))}–${f(Math.max(...values))}`;
const summaries=[];
let markdown='';
for(const run of runs){
  const all=rows.filter(row=>row.run===run), disposed=all.filter(row=>row.label==='disposed-gc');
  const first=disposed.slice(0,5), last=disposed.slice(-5), soak=all.filter(row=>row.label.startsWith('soak'));
  if(!disposed.length)continue;
  const summary={run,cycles:disposed.length,firstHeap:median(first.map(row=>row.heapMiB)),lastHeap:median(last.map(row=>row.heapMiB)),firstRss:median(first.map(row=>row.rendererRssMiB)),lastRss:median(last.map(row=>row.rendererRssMiB)),peakRss:Math.max(...all.map(row=>row.rendererRssMiB)),peakHeap:Math.max(...all.map(row=>row.heapMiB)),peakTracks:Math.max(...all.map(row=>row.activeTracks)),peakPeers:Math.max(...all.map(row=>row.openPeers)),peakTimers:Math.max(...all.map(row=>row.timers)),maxDisposedTracks:Math.max(...disposed.map(row=>row.activeTracks)),maxDisposedPeers:Math.max(...disposed.map(row=>row.openPeers)),maxDisposedTimers:Math.max(...disposed.map(row=>row.timers)),cgroupPeakMiB:Math.max(...all.map(row=>row.cgroupPeakMiB??0))};
  summaries.push(summary);
  markdown+=`\n### ${run}\n\nNatural expiry and seven-minute incident window (memory in MiB; no forced GC):\n\n| Seconds | Stage | JS heap | Renderer RSS | Live tracks | Open peers | Canvases alive / in DOM | Workers / CDP worker targets | Timers | Grants / 403 |\n|---:|---|---:|---:|---:|---:|---|---|---:|---|\n`;
  for(const row of soak)markdown+=`| ${f(row.elapsedSeconds)} | ${row.label} | ${f(row.heapMiB)} | ${f(row.rendererRssMiB)} | ${row.activeTracks} | ${row.openPeers} | ${row.canvases} / ${row.domCanvases} | ${row.activeWorkers} / ${row.workerTargets} | ${row.timers} | ${row.grants} / ${row.forbidden} |\n`;
  markdown+='\nTwenty-one accelerated seat-expiry → refresh → real 403 → dispose cycles. P = pending join, F = stale 403, D = disposed and forced GC. Memory in MiB.\n\n| Cycle | JS heap P / F / D | Renderer RSS P / F / D | Live tracks P / F / D | Open peers P / F / D | Timers P / F / D | Canvases D | Workers D |\n|---:|---|---|---|---|---|---:|---:|\n';
  for(const row of disposed){
    const trio=['pending','stale-403','disposed-gc'].map(label=>all.find(item=>item.cycle===row.cycle&&item.label===label));
    const column=(key,format=String)=>trio.map(item=>format(item[key])).join(' / ');
    markdown+=`| ${row.cycle} | ${column('heapMiB',f)} | ${column('rendererRssMiB',f)} | ${column('activeTracks')} | ${column('openPeers')} | ${column('timers')} | ${row.canvases} | ${row.activeWorkers} |\n`;
  }
  markdown+=`\nFirst-five versus last-five disposed medians: JS heap **${f(summary.firstHeap)} → ${f(summary.lastHeap)} MiB**, renderer RSS **${f(summary.firstRss)} → ${f(summary.lastRss)} MiB**. Disposed heap range ${range(disposed.map(row=>row.heapMiB))} MiB; renderer range ${range(disposed.map(row=>row.rendererRssMiB))} MiB.\n`;
}
await writeFile(`${destination}/measurement-tables.md`,markdown);
await writeFile(`${destination}/summary.json`,JSON.stringify(summaries,null,2));
console.log(JSON.stringify(summaries,null,2));
