#!/usr/bin/env node
// =============================================================================
// build-ecosystem.mjs — compile the JAX-on-NVIDIA-GPU stack diagram.
//
// Reads docs/ecosystem/stack.yml + per-project markdown snippets and renders a
// CSS-only, MDX-safe interactive diagram (grid of layers x columns of nodes +
// :target-revealed overview panels + legend) into
// docs/ecosystem/jax-on-nvidia-gpu-stack.mdx, between the ECOSYSTEM:START/END
// markers. Prose outside the markers is never touched.
//
// Design notes (validated by the MDX spike, see docs/ecosystem/plan.md):
//   * Emit `className` (MDX) — Fern renders it to `class`.
//   * Node anchors use in-page `#proj-<id>` hrefs; the `.eco-panel:target` CSS
//     rule reveals the matching panel. Fern rewrites the hash to /page#id.
//   * Panel bodies are emitted as raw markdown wrapped in blank lines inside the
//     JSX <div>, so MDX renders them — snippets stay pure markdown, no md->html.
//   * Fail-soft: missing snippet -> placeholder + warning; unknown
//     column/layer -> warning + skip; never throws on content problems. Hard
//     errors (no config / bad YAML / missing markers) exit non-zero.
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import yaml from "js-yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ECO_DIR = join(ROOT, "docs", "ecosystem");
const CONFIG = join(ECO_DIR, "stack.yml");
const PAGE = join(ECO_DIR, "jax-on-nvidia-gpu-stack.mdx");

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
const layers = cfg.layers ?? [];
const categories = cfg.categories ?? {};
const contribution = cfg.contribution ?? null;
const projects = cfg.projects ?? [];

if (!columns.length) die("no `columns` defined");
if (!layers.length) die("no `layers` defined");
if (!projects.length) die("no `projects` defined");
if (columns.length !== 3)
  warn(`CSS grid is tuned for 3 columns; found ${columns.length} (adjust .eco-diagram-grid in main.css)`);

const colIds = columns.map((c) => c.id);
const layerById = new Map(layers.map((l) => [l.id, l]));

// MDX text can't contain raw { } < > — guard project names.
const safe = (s, where) => {
  if (/[{}<>]/.test(s)) warn(`unsafe char in ${where}: "${s}" (stripped)`);
  return String(s).replace(/[{}<>]/g, "");
};

// ----- validate + index projects ------------------------------------------
const seen = new Set();
const placed = []; // {p, clickable}
for (const p of projects) {
  if (!p.id) { warn(`project with no id (name="${p.name ?? "?"}") skipped`); continue; }
  if (seen.has(p.id)) { warn(`duplicate project id "${p.id}" skipped`); continue; }
  seen.add(p.id);
  if (!colIds.includes(p.column)) { warn(`project "${p.id}" has unknown column "${p.column}" — skipped`); continue; }
  if (!layerById.has(p.layer)) { warn(`project "${p.id}" has unknown layer "${p.layer}" — skipped`); continue; }
  if (p.category && !categories[p.category]) warn(`project "${p.id}" has unknown category "${p.category}" — using 'other'`);
  placed.push({ p, clickable: Boolean(p.overview) });
}

const catClass = (p) => (categories[p.category]?.class) ?? "eco-cat-other";
const nodeClasses = (p) => {
  const cls = ["eco-node", catClass(p)];
  if (p.nvidia_contributes) cls.push("eco-contributes");
  if (!p.overview) cls.push("eco-node--static");
  return cls.join(" ");
};

// ----- render nodes --------------------------------------------------------
const projectsIn = (layerId, colId) =>
  placed.filter(({ p }) => p.layer === layerId && p.column === colId).map(({ p }) => p);

const renderNode = (p) => {
  const name = safe(p.name ?? p.id, `project ${p.id} name`);
  return p.overview
    ? `<a className="${nodeClasses(p)}" href="#proj-${p.id}">${name}</a>`
    : `<span className="${nodeClasses(p)}">${name}</span>`;
};

const renderCell = (nodes, extraClass = "") =>
  `<div className="eco-cell${extraClass}">\n${nodes.map(renderNode).join("\n") || ""}\n</div>`;

// ----- diagram grid (layers rendered top -> bottom) ------------------------
const gridParts = [];
gridParts.push(`<div className="eco-diagram-grid" role="group" aria-label="JAX on NVIDIA GPU stack">`);
gridParts.push(`<div className="eco-corner" />`);
for (const c of columns) gridParts.push(`<div className="eco-colhead">${safe(c.label, `column ${c.id}`)}</div>`);

let nodeCount = 0;
for (const layer of [...layers].reverse()) {
  gridParts.push(`<div className="eco-rowlabel">${safe(layer.label, `layer ${layer.id}`)}</div>`);
  if (layer.span === "full") {
    const nodes = columns.flatMap((c) => projectsIn(layer.id, c.id));
    nodeCount += nodes.length;
    gridParts.push(renderCell(nodes, " eco-cell--full"));
  } else {
    for (const c of columns) {
      const nodes = projectsIn(layer.id, c.id);
      nodeCount += nodes.length;
      gridParts.push(renderCell(nodes));
    }
  }
}
gridParts.push(`</div>`);

// ----- overview panels (default panel LAST so the :target ~ rule works) ----
const readSnippet = (p) => {
  const rel = p.overview;
  const file = join(ECO_DIR, rel);
  if (!existsSync(file)) {
    warn(`missing snippet for "${p.id}": ${rel}`);
    return `_Overview coming soon._`;
  }
  const body = readFileSync(file, "utf8").trim();
  if (!body) { warn(`empty snippet for "${p.id}": ${rel}`); return `_Overview coming soon._`; }
  return body;
};

const panelParts = [`<div className="eco-panels">`];
for (const { p, clickable } of placed) {
  if (!clickable) continue; // static nodes (e.g. hardware) have no panel
  const learn = p.href ? `\n\n[Learn more →](${p.href})` : "";
  // Blank lines around the body => MDX renders it as markdown inside the JSX div.
  panelParts.push(
    `<div className="eco-panel" id="proj-${p.id}">\n\n**${safe(p.name ?? p.id, p.id)}**\n\n${readSnippet(p)}${learn}\n\n</div>`
  );
}
panelParts.push(
  `<div className="eco-panel eco-panel--default">\n\nSelect a project in the diagram to see its overview.\n\n</div>`
);
panelParts.push(`</div>`);

// ----- legend --------------------------------------------------------------
const legendParts = [`<div className="eco-legend" aria-hidden="true">`];
for (const key of Object.keys(categories)) {
  const c = categories[key];
  legendParts.push(`<span className="eco-legend-item"><span className="eco-swatch ${c.class}" />${safe(c.label, `category ${key}`)}</span>`);
}
if (contribution)
  legendParts.push(`<span className="eco-legend-item"><span className="eco-swatch eco-contributes" />${safe(contribution.label, "contribution")}</span>`);
legendParts.push(`</div>`);

// ----- compose + splice ----------------------------------------------------
const block = [
  legendParts.join("\n"),
  ``,
  `<div className="eco-wrap">`,
  gridParts.join("\n"),
  panelParts.join("\n"),
  `</div>`,
].join("\n");

if (!existsSync(PAGE)) die(`page not found: ${PAGE}`);
let page = readFileSync(PAGE, "utf8");
const markerRe = /(\{\/\* ECOSYSTEM:START[\s\S]*?\*\/\})[\s\S]*?(\{\/\* ECOSYSTEM:END \*\/\})/;
if (!markerRe.test(page)) die(`ECOSYSTEM:START/END markers not found in ${PAGE}`);
page = page.replace(markerRe, `$1\n\n${block}\n\n$2`);
writeFileSync(PAGE, page);

// ----- summary -------------------------------------------------------------
const clickableCount = placed.filter((x) => x.clickable).length;
console.log(`[ecosystem] ${placed.length} projects placed (${clickableCount} with panels, ${nodeCount} nodes in grid)`);
console.log(`[ecosystem] wrote ${PAGE.replace(ROOT + "/", "")}`);
if (warnings.length) {
  console.log(`[ecosystem] ${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  - ${w}`);
} else {
  console.log(`[ecosystem] no warnings`);
}
