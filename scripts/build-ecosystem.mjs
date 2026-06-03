#!/usr/bin/env node
// =============================================================================
// build-ecosystem.mjs — compile the JAX-on-NVIDIA-GPU stack diagram.
//
// Reads docs/ecosystem/stack.yml + per-project markdown snippets and renders a
// CSS-only, MDX-safe interactive diagram into
// docs/ecosystem/jax-on-nvidia-gpu-stack.mdx (between the ECOSYSTEM markers),
// plus docs/ecosystem/ecosystem.generated.css (selected-node highlight).
//
// UNIT-GRID / ROW-FLOW MODEL:
//   columns carry a `width` in UNITS; total U = sum(widths) is the grid
//   resolution (U equal 1fr tracks). Column headers span their unit range.
//   Each row's `cells` FLOW left-to-right: cell i starts where i-1 ended and
//   occupies `width` units — so a cell can straddle a column boundary. Rendered
//   via CSS Grid with inline style={{gridColumn,gridRow}} (verified in Fern MDX).
//
// Design notes (validated by spikes, see docs/ecosystem/plan.md):
//   * Emit `className`/`htmlFor` and inline `style={{...}}` objects (MDX/JSX).
//   * Reveal = radio :checked hack (Fern's pushState links break :target):
//     node = <label> toggling a hidden radio adjacent to its panel.
//   * Fail-soft: missing snippet / unknown project / row over-budget -> warn
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
const projects = cfg.projects ?? [];

if (!columns.length) die("no `columns` defined");
if (!rows.length) die("no `rows` defined");
if (!projects.length) die("no `projects` defined");

const U = columns.reduce((s, c) => s + (Number(c.width) || 1), 0); // total units

const byId = new Map();
for (const p of projects) {
  if (!p.id) { warn(`project with no id (name="${p.name ?? "?"}") skipped`); continue; }
  if (byId.has(p.id)) { warn(`duplicate project id "${p.id}" in registry`); continue; }
  byId.set(p.id, p);
}

// MDX text can't contain raw { } < > — guard label text.
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

// ----- build the grid ------------------------------------------------------
// Track 1 = row-label column; data unit u (1-based) lives on track u+1.
// Row 1 = header row; data row j (0-based) lives on grid-row j+2.
const used = new Set();
const clickable = []; // ordered project objects with panels
let cellCount = 0;

const template = `max-content repeat(${U}, 1fr)`;
const grid = [`<div className="eco-diagram-grid" role="group" aria-label="JAX on NVIDIA GPU stack" style={{gridTemplateColumns: "${template}"}}>`];
grid.push(`<div className="eco-corner" style={{gridColumn: "1", gridRow: "1"}} />`);

// Column headers span their unit range.
let cu = 0;
for (const c of columns) {
  const w = Number(c.width) || 1;
  grid.push(`<div className="eco-colhead" style={{gridColumn: "${cu + 2} / span ${w}", gridRow: "1"}}>${safe(c.label, `column ${c.id}`)}</div>`);
  cu += w;
}

// Rows: label on track 1, then cells flow left-to-right by unit width.
rows.forEach((r, j) => {
  const gr = j + 2;
  grid.push(`<div className="eco-rowlabel" style={{gridColumn: "1", gridRow: "${gr}"}}>${safe(r.label ?? r.id, `row ${r.id}`)}</div>`);
  let pos = 0; // units consumed in this row
  for (const cell of r.cells ?? []) {
    let w = Number(cell.width) || 1;
    if (pos + w > U) {
      warn(`row "${r.id}" cells exceed ${U} units; clamped`);
      w = U - pos;
    }
    if (w <= 0) { warn(`row "${r.id}" cell has no room left; skipped`); continue; }
    const nodes = [];
    for (const pid of cell.projects ?? []) {
      const p = byId.get(pid);
      if (!p) { warn(`row "${r.id}" references unknown project "${pid}" — skipped`); continue; }
      if (used.has(pid)) warn(`project "${pid}" placed more than once`);
      used.add(pid);
      nodes.push(renderNode(p));
      if (p.overview && !clickable.includes(p)) clickable.push(p);
    }
    const inner = [];
    if (cell.label) inner.push(`<div className="eco-cell-label">${safe(cell.label, `cell label in row ${r.id}`)}</div>`);
    inner.push(...nodes);
    grid.push(`<div className="eco-cell" style={{gridColumn: "${pos + 2} / span ${w}", gridRow: "${gr}"}}>\n${inner.join("\n")}\n</div>`);
    pos += w;
    cellCount++;
  }
});
grid.push(`</div>`);

for (const p of projects) if (p.id && !used.has(p.id)) warn(`project "${p.id}" is in the registry but not placed in any row`);

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
console.log(`[ecosystem] ${used.size} projects placed in ${cellCount} cells across ${rows.length} rows (${clickable.length} with panels)`);
console.log(`[ecosystem] grid: ${U} units — columns ${columns.map((c) => `${c.id}=${c.width ?? 1}`).join(" / ")}`);
console.log(`[ecosystem] wrote ${PAGE.replace(ROOT + "/", "")} and ${CSS_OUT.replace(ROOT + "/", "")}`);
if (warnings.length) {
  console.log(`[ecosystem] ${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  - ${w}`);
} else {
  console.log(`[ecosystem] no warnings`);
}
