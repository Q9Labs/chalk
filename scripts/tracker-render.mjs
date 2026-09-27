import { groupOutcomes } from "./tracker-data.mjs";

const html = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const stateLabels = {
  planned: "Not started",
  in_progress: "Partly working",
  blocked: "Blocked",
  unknown: "Unclear",
};

// Both views number outcomes in the same order, so a reader can refer to "#12" in either.
const numberedGroups = (tracker) => {
  let number = 0;
  return groupOutcomes(tracker).map((group) => ({ ...group, items: group.items.map((item) => ({ ...item, number: ++number })) }));
};

const meta = (item) => [stateLabels[item.state], item.size && `size ${item.size}`, item.priority].filter(Boolean).join(" · ");
const metaHtml = (item) => [`<span class="state">${stateLabels[item.state]}</span>`, item.size && `size ${html(item.size)}`, item.priority && html(item.priority)].filter(Boolean).join(" · ");

const appendWord = (line, word, prefix, continuation) => {
  if (line === prefix || line === continuation) return `${line}${word}`;
  return `${line} ${word}`;
};
const lineFits = (candidate, line, prefix, continuation) => candidate.length <= 88 || line === prefix || line === continuation;

const textLines = (text, prefix = "", continuation = " ".repeat(prefix.length)) => {
  const lines = [];
  let line = prefix;
  for (const word of text.replaceAll("<", "‹").replaceAll(">", "›").split(/\s+/u)) {
    const candidate = appendWord(line, word, prefix, continuation);
    if (lineFits(candidate, line, prefix, continuation)) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = `${continuation}${word}`;
  }
  if (line.trim()) lines.push(line);
  return lines;
};

const markdownItem = (item) => [
  ...textLines(`**${item.title}** (${meta(item)})`, `${item.number}. `, "    "),
  ...textLines(item.summary, "    "),
  ...(item.blocked_by ? textLines(`Waiting on: ${item.blocked_by}`, "    ") : []),
  ...(item.uncertainty ? textLines(`Open question: ${item.uncertainty}`, "    ") : []),
  ...(item.remaining ?? []).flatMap((step) => textLines(step, "    - ", "      ")),
  "",
];

export const renderMarkdown = (tracker) => {
  const lines = ["# Chalk tracker", "", ...textLines(tracker.principle), "", ...textLines(tracker.sizing), "", "Generated from tracker.yaml; run pnpm generate:tracker after editing it.", ""];
  for (const group of numberedGroups(tracker)) lines.push(`## ${group.title}`, "", ...group.items.flatMap(markdownItem));
  return `${lines.join("\n").trimEnd()}\n`;
};

const searchText = (item) => [item.number, item.title, item.summary, item.uncertainty, item.blocked_by, ...(item.remaining ?? []), meta(item)].filter(Boolean).join(" ").toLowerCase();

const noteHtml = (label, value) => (value ? `<p class="note"><b>${label}:</b> ${html(value)}</p>` : "");
const stepsHtml = (steps = []) => (steps.length ? `<ul>${steps.map((step) => `<li>${html(step)}</li>`).join("")}</ul>` : "");

const itemHtml = (item) => `<li class="item" id="${html(item.id)}" data-state="${item.state}" data-search="${html(searchText(item))}">
<div class="head"><span class="number">${item.number}</span><h3>${html(item.title)}</h3></div>
<p class="meta"><span class="dot" aria-hidden="true"></span>${metaHtml(item)}</p>
<p>${html(item.summary)}</p>${noteHtml("Waiting on", item.blocked_by)}${noteHtml("Open question", item.uncertainty)}${stepsHtml(item.remaining)}</li>`;

const groupHtml = (group) => `<section><h2>${html(group.title)}</h2><ol class="items">${group.items.map(itemHtml).join("\n")}</ol></section>`;

const stateFilter = ({ outcomes }) =>
  [["all", "All"], ...Object.entries(stateLabels).filter(([value]) => outcomes.some((item) => item.state === value))]
    .map(([value, text]) => {
      const count = value === "all" ? outcomes.length : outcomes.filter((item) => item.state === value).length;
      const dot = value === "all" ? "" : '<span class="dot" aria-hidden="true"></span>';
      return `<label data-state="${value}"><input type="radio" name="state" value="${value}"${value === "all" ? " checked" : ""}>${dot}${text} <span class="n">${count}</span></label>`;
    })
    .join("");

export const renderHtml = (tracker) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Chalk tracker</title>
<style>
:root{color-scheme:dark;--canvas:#0d1714;--panel:#14221d;--input:#13211c;--ink:#eff3e9;--muted:#9bab9f;--line:#30473d;--line-strong:#466355;--green:#8fd18a;--blue:#76bed1;--yellow:#e6c65a;--pink:#e89090;--slate:#a9b8d8}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink);font:16px/1.55 Figtree,system-ui,sans-serif}
main{max-width:46rem;margin-inline:auto;padding:48px 20px 96px}
h1{font-size:1.75rem;line-height:1.2;margin:0 0 8px}
h2{font-size:1.15rem;margin:48px 0 0;padding-bottom:8px;border-bottom:1px solid var(--line-strong);color:var(--yellow)}
h3{font-size:1.02rem;margin:0}
p{margin:6px 0}
.intro{color:var(--muted);margin-bottom:24px}
.controls{position:sticky;top:0;background:var(--canvas);padding:12px 0;border-bottom:1px solid var(--line);z-index:1}
input[type=search]{width:100%;padding:10px 12px;font:inherit;color:var(--ink);border:1px solid var(--line-strong);border-radius:8px;background:var(--input)}
input[type=search]::placeholder{color:var(--muted)}
.states{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.states label{display:flex;align-items:center;gap:6px;font-size:.875rem;padding:4px 12px;border:1px solid var(--line);border-radius:999px;cursor:pointer;background:var(--panel);color:var(--ink)}
.states .n{color:var(--muted);font-family:"Spline Sans Mono",ui-monospace,monospace;font-size:.8rem}
.states input{position:absolute;opacity:0}
.states label:has(input:checked){border-color:var(--c,var(--ink));background:color-mix(in srgb,var(--c,var(--ink)) 18%,var(--panel))}
.states label:has(input:focus-visible),input[type=search]:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.count{font-size:.875rem;color:var(--muted);margin-top:8px}
.items{list-style:none;margin:0;padding:0}
.item{padding:20px 0;border-bottom:1px solid var(--line)}
.head{display:flex;gap:12px;align-items:baseline}
.number{font:500 .875rem/1 "Spline Sans Mono",ui-monospace,monospace;color:var(--blue);min-width:2ch}
.meta{font-size:.875rem;color:var(--muted);display:flex;align-items:center;gap:6px}
.meta .state{color:var(--c);font-weight:600}
.dot{width:8px;height:8px;border-radius:50%;background:var(--c);flex:none}
[data-state=in_progress]{--c:var(--green)}[data-state=unknown]{--c:var(--yellow)}[data-state=blocked]{--c:var(--pink)}[data-state=planned]{--c:var(--slate)}
.note{color:var(--muted)}
.note b{color:var(--yellow);font-weight:600}
.item ul{margin:8px 0 0;padding-inline-start:20px}
.item li::marker{color:var(--line-strong)}
.item li+li{margin-top:4px}
[hidden]{display:none!important}
@media print{.controls{display:none}.item{break-inside:avoid}}
</style></head><body><main>
<h1>Chalk tracker</h1>
<p class="intro">${html(tracker.principle)}</p>
<div class="controls">
<input id="search" type="search" aria-label="Search outcomes" placeholder="Search by number or text">
<div class="states" role="radiogroup" aria-label="Filter by state">${stateFilter(tracker)}</div>
<p class="count" id="count" aria-live="polite">${tracker.outcomes.length} outcomes</p>
</div>
${numberedGroups(tracker).map(groupHtml).join("\n")}
<p class="intro" id="empty" hidden>No outcomes match. Clear the search or pick another state.</p>
</main>
<script type="module">
const search=document.getElementById('search');
const items=[...document.querySelectorAll('.item')];
const update=()=>{
 const query=search.value.trim().toLowerCase();
 const state=document.querySelector('input[name=state]:checked').value;
 let visible=0;
 for(const item of items){item.hidden=!(item.dataset.search.includes(query)&&(state==='all'||item.dataset.state===state));if(!item.hidden)visible++;}
 for(const section of document.querySelectorAll('section'))section.hidden=!section.querySelector('.item:not([hidden])');
 document.getElementById('count').textContent=visible+' of '+items.length+' outcomes';
 document.getElementById('empty').hidden=visible!==0;
};
search.addEventListener('input',update);
for(const radio of document.querySelectorAll('input[name=state]'))radio.addEventListener('change',update);
</script></body></html>
`;
