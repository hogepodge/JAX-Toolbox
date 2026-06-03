#!/usr/bin/env node
// =============================================================================
// build-ecosystem.mjs — compile the JAX-on-NVIDIA-GPU stack diagram.
//
// Reads docs/ecosystem/stack.yml + per-project markdown snippets and renders a
// CSS-only, MDX-safe interactive diagram into
// docs/ecosystem/jax-on-nvidia-gpu-stack.mdx (between the ECOSYSTEM markers),
// plus docs/ecosystem/ecosystem.generated.css (selected-node highlight).
//
// FLEXIBLE GRID MODEL:
//   columns (with `width` fr weights) x rows, with `cells` placed as rectangles
//   (col/colSpan/row/rowSpan). Emitted via CSS Grid: the container sets
//   grid-template-columns from the weights, and each cell/label/header gets an
//   inline style={{gridColumn, gridRow}} (verified to render in Fern MDX).
//
// Design notes (validated by spikes, see docs/ecosystem/plan.md):
//   * Emit `className`/`htmlFor` and inline `style={{...}}` objects (MDX/JSX).
//   * Reveal is the radio :checked hack (Fern's pushState links break :target):
//     node = <label> toggling a hidden radio adjacent to its panel.
//   * Fail-soft: missing snippet / unknown project / overflowing span -> warn
//     (and clamp/skip), never throw. Hard errors (no config / bad YAML / missing
//     markers) exit non-zero.
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import yaml from "js-yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ECO_DIR = join(ROOT, "docs", "ecosystem");
const CONFIG = join(ECO_DIR, "stack.yml");
const PAGE = join(ECO_DIR, "jax-on-nvidia-gpu-stack.mdx");
const CSS_OUT = join(ECO_DIR, "ecosystem.generated.css");

const warnings = [];
const warn = (m) => warnings.push(m);
const die = (m) => {
  console.error(`\n[ecosystem] ERROR: ${m}\n`);
  process.exit(1);
};

// ----- load + parse --------------------------------------------------------
if (!existsSync(CONFIG)) die(`config not found: ${CONFIG}`);
let cfg;
try {
  cfg = yaml.load(readFileSync(CONFIG, "utf8"));
} catch (e) {
  die(`could not parse ${CONFIG}: ${e.message}`);
}

const columns = cfg.columns ?? [];
const rows = cfg.rows ?? [];
const categories = cfg.categories ?? {};
const cells = cfg.cells ?? [];
const projects = cfg.projects ?? [];

if (!columns.length) die("no `columns` defined");
if (!rows.length) die("no `rows` defined");
if (!cells.length) die("no `cells` defined");
if (!projects.length) die("no `projects` defined");

const colIndex = new Map(columns.map((c, i) => [c.id, i]));
const rowIndex = new Map(rows.map((r, i) => [r.id, i]));
const byId = new Map();
for (const p of projects) {
  if (!p.id) { warn(`project with no id (name="${p.name ?? "?"}") skipped`); continue; }
  if (byId.has(p.id)) { warn(`duplicate project id "${p.id}" in registry`); continue; }
  byId.set(p.id, p);
}

// MDX text can't contain raw { } < > — guard project/label text.
const safe = (s, where) => {
  if (/[{}<>]/.test(String(s))) warn(`unsafe char in ${where}: "${s}" (stripped)`);
  return String(s).replace(/[{}<>]/g, "");
};

const catClass = (p) => categories[p.category]?.class ?? "eco-cat-other";
const nodeClasses = (p) => {
  const cls = ["eco-node", catClass(p)];
  if (!p.overview) cls.push("eco-node--static");
  return cls.join(" ");
};
const renderNode = (p) => {
  const name = safe(p.name ?? p.id, `project ${p.id} name`);
  return p.overview
    ? `<label className="${nodeClasses(p)}" htmlFor="r-${p.id}">${name}</label>`
    : `<span className="${nodeClasses(p)}">${name}</span>`;
};

// ----- place cells ---------------------------------------------------------
// Grid lines: label column = line 1, data column i => line i+2. Header row =
// line 1, data row j => line j+2.
const used = new Set();
const clickable = []; // ordered project objects with panels
const cellEls = [];

for (const cell of cells) {
  if (!colIndex.has(cell.col)) { warn(`cell at row "${cell.row}" has unknown col "${cell.col}" — skipped`); continue; }
  if (!rowIndex.has(cell.row)) { warn(`cell at col "${cell.col}" has unknown row "${cell.row}" — skipped`); continue; }
  const ci = colIndex.get(cell.col);
  const ri = rowIndex.get(cell.row);
  let colSpan = Number(cell.colSpan ?? 1);
  let rowSpan = Number(cell.rowSpan ?? 1);
  if (ci + colSpan > columns.length) {
    warn(`cell (${cell.col},${cell.row}) colSpan ${colSpan} overflows; clamped`);
    colSpan = columns.length - ci;
  }
  if (ri + rowSpan > rows.length) {
    warn(`cell (${cell.col},${cell.row}) rowSpan ${rowSpan} overflows; clamped`);
    rowSpan = rows.length - ri;
  }
  const nodes = [];
  for (const pid of cell.projects ?? []) {
    const p = byId.get(pid);
    if (!p) { warn(`cell (${cell.col},${cell.row}) references unknown project "${pid}" — skipped`); continue; }
    if (used.has(pid)) warn(`project "${pid}" placed more than once`);
    used.add(pid);
    nodes.push(renderNode(p));
    if (p.overview && !clickable.includes(p)) clickable.push(p);
  }
  const gc = `${ci + 2} / span ${colSpan}`;
  const gr = `${ri + 2} / span ${rowSpan}`;
  cellEls.push(
    `<div className="eco-cell" style={{gridColumn: "${gc}", gridRow: "${gr}"}}>\n${nodes.join("\n")}\n</div>`
  );
}

for (const p of projects) if (p.id && !used.has(p.id)) warn(`project "${p.id}" is in the registry but not placed in any cell`);

// ----- grid (container + headers + row labels + cells) ---------------------
const template = "max-content " + columns.map((c) => `${c.width ?? 1}fr`).join(" ");
const grid = [`<div className="eco-diagram-grid" role="group" aria-label="JAX on NVIDIA GPU stack" style={{gridTemplateColumns: "${template}"}}>`];
grid.push(`<div className="eco-corner" style={{gridColumn: "1", gridRow: "1"}} />`);
columns.forEach((c, i) =>
  grid.push(`<div className="eco-colhead" style={{gridColumn: "${i + 2}", gridRow: "1"}}>${safe(c.label, `column ${c.id}`)}</div>`)
);
rows.forEach((r, j) =>
  grid.push(`<div className="eco-rowlabel" style={{gridColumn: "1", gridRow: "${j + 2}"}}>${safe(r.label, `row ${r.id}`)}</div>`)
);
grid.push(...cellEls);
grid.push(`</div>`);

// ----- overview panels (radio :checked reveal; default panel LAST) ---------
const readSnippet = (p) => {
  const file = join(ECO_DIR, p.overview);
  if (!existsSync(file)) { warn(`missing snippet for "${p.id}": ${p.overview}`); return `_Overview coming soon._`; }
  const body = readFileSync(file, "utf8").trim();
  if (!body) { warn(`empty snippet for "${p.id}": ${p.overview}`); return `_Overview coming soon._`; }
  return body;
};

const panelParts = [`<div className="eco-panels">`];
for (const p of clickable) {
  const learn = p.href ? `\n\n[Learn more →](${p.href})` : "";
  panelParts.push(
    `<div className="eco-choice">\n<input className="eco-radio" type="radio" name="eco-sel" id="r-${p.id}" />\n<div className="eco-panel" id="proj-${p.id}">\n\n**${safe(p.name ?? p.id, p.id)}**\n\n${readSnippet(p)}${learn}\n\n</div>\n</div>`
  );
}
panelParts.push(`<div className="eco-panel eco-panel--default">\n\nSelect a project in the diagram to see its overview.\n\n</div>`);
panelParts.push(`</div>`);

// ----- legend --------------------------------------------------------------
const legendParts = [`<div className="eco-legend" aria-hidden="true">`];
for (const key of Object.keys(categories)) {
  const c = categories[key];
  legendParts.push(`<span className="eco-legend-item"><span className="eco-swatch ${c.class}" />${safe(c.label, `category ${key}`)}</span>`);
}
legendParts.push(`</div>`);

// ----- compose + splice page ----------------------------------------------
const block = [legendParts.join("\n"), ``, `<div className="eco-wrap">`, grid.join("\n"), panelParts.join("\n"), `</div>`].join("\n");

if (!existsSync(PAGE)) die(`page not found: ${PAGE}`);
let page = readFileSync(PAGE, "utf8");
const markerRe = /(\{\/\* ECOSYSTEM:START[\s\S]*?\*\/\})[\s\S]*?(\{\/\* ECOSYSTEM:END \*\/\})/;
if (!markerRe.test(page)) die(`ECOSYSTEM:START/END markers not found in ${PAGE}`);
page = page.replace(markerRe, `$1\n\n${block}\n\n$2`);
writeFileSync(PAGE, page);

// ----- generated CSS: highlight the selected node --------------------------
const selectors = clickable.map((p) => `.eco-wrap:has(#r-${p.id}:checked) label[for="r-${p.id}"]`);
const css = [
  `/* AUTO-GENERATED by scripts/build-ecosystem.mjs — do not edit by hand.`,
  ` * Highlights the selected project node (the <label> whose radio is checked). */`,
  selectors.length
    ? `${selectors.join(",\n")} {\n  font-weight: 700;\n  outline: 2px solid var(--nv-green);\n  outline-offset: 1px;\n}`
    : `/* no clickable projects */`,
  ``,
].join("\n");
writeFileSync(CSS_OUT, css);

// ----- summary -------------------------------------------------------------
console.log(`[ecosystem] ${used.size} projects placed across ${cells.length} cells (${clickable.length} with panels)`);
console.log(`[ecosystem] grid: ${columns.length} columns (${columns.map((c) => c.width ?? 1).join("/")}) x ${rows.length} rows`);
console.log(`[ecosystem] wrote ${PAGE.replace(ROOT + "/", "")} and ${CSS_OUT.replace(ROOT + "/", "")}`);
if (warnings.length) {
  console.log(`[ecosystem] ${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  - ${w}`);
} else {
  console.log(`[ecosystem] no warnings`);
}
