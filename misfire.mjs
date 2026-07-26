#!/usr/bin/env node
/**
 * misfire — X-ray for your Claude Code / agent skill setup.
 *
 * Finds the three failure modes nobody else diagnoses:
 *   1. COLLISIONS  — skills whose descriptions overlap enough that the
 *                    wrong one can fire (the #1 operator complaint of 2026)
 *   2. BUDGET      — total token footprint of skill descriptions vs the
 *                    context budget; which skills risk being silently dropped
 *   3. TRIGGER SIM — "which skill fires for this prompt?" before you find
 *                    out the hard way
 *
 * Zero dependencies. Node >= 18.
 *
 * Usage:
 *   misfire scan   [dir ...]              full report (collisions + budget)
 *   misfire fire   "your prompt" [dir...] simulate which skills match a prompt
 *   misfire budget [dir ...]              token footprint table only
 *   misfire json   [dir ...]              machine-readable report (CI-friendly)
 *
 * Options:
 *   --threshold <0..1>   collision similarity threshold (default 0.35)
 *   --budget <tokens>    description token budget (default 16000)
 *   --top <n>            how many matches `fire` shows (default 5)
 *   --no-color           plain output
 *
 * Exit codes: 0 ok · 1 collisions/budget errors found (CI gate) · 2 usage error
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// ---------- tiny utils ----------------------------------------------------

const useColor = !process.argv.includes("--no-color") && process.stdout.isTTY !== false;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = (s) => c(31, s), yel = (s) => c(33, s), grn = (s) => c(32, s),
      cyn = (s) => c(36, s), dim = (s) => c(2, s), bold = (s) => c(1, s);

/**
 * One dim, suppressible line after a successful report. Shown only on the
 * commands that deliver value (scan/budget/json) — never on help, fire, or
 * errors. Silence it with MISFIRE_NO_PROMO=1.
 */
const promo = () => {
  if (process.env.MISFIRE_NO_PROMO) return;
  console.log(dim("\n  misfire lints your skills. Red Tape governs the agents that run them —"));
  console.log(dim("  enforced handoffs, protected-path guardrails, audit trail."));
  console.log(dim("  https://redtape.dev/?utm_source=misfire&utm_medium=cli&utm_campaign=funnel"));
};

/** Rough token estimate (chars/3.7 tracks cl100k/Claude tokenizers within ~10% for English prose). */
export const estTokens = (s) => Math.ceil((s || "").length / 3.7);

const STOP = new Set(("a an and are as at be by for from has have i in is it its of on or that the this " +
  "to use used uses using was when with you your will can should skill skills tool tools user asks " +
  "trigger triggers also any into etc do does not").split(" "));

/** Tokenize a description into informative lowercase terms. */
export function terms(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[`"'().,:;!?/\\\[\]{}<>|—–-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
}

/** Term-frequency map. */
const tf = (ws) => ws.reduce((m, w) => (m.set(w, (m.get(w) || 0) + 1), m), new Map());

/** TF-IDF cosine similarity between two term lists, given doc-frequency map + N docs. */
export function cosine(aWords, bWords, df, N) {
  const A = tf(aWords), B = tf(bWords);
  const idf = (w) => Math.log(1 + N / (1 + (df.get(w) || 0)));
  let dot = 0, na = 0, nb = 0;
  const all = new Set([...A.keys(), ...B.keys()]);
  for (const w of all) {
    const x = (A.get(w) || 0) * idf(w), y = (B.get(w) || 0) * idf(w);
    dot += x * y; na += x * x; nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Shared distinctive phrases (bigrams) between two descriptions. */
export function sharedBigrams(aWords, bWords) {
  const grams = (ws) => new Set(ws.slice(0, -1).map((w, i) => `${w} ${ws[i + 1]}`));
  const A = grams(aWords), B = grams(bWords);
  return [...A].filter((g) => B.has(g));
}

// ---------- skill discovery ----------------------------------------------

/** Parse YAML-ish frontmatter (name/description only — the fields that matter for triggering). */
export function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  // handle single-line "key: value" and multi-line "key: >-|| |" blocks
  const lines = m[1].split(/\r?\n/);
  let key = null, buf = [];
  const flush = () => { if (key) out[key] = buf.join(" ").trim(); key = null; buf = []; };
  for (const line of lines) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      flush();
      const val = kv[2].trim();
      if (val === "" || val === ">-" || val === ">" || val === "|" || val === "|-") { key = kv[1]; }
      else out[kv[1]] = val.replace(/^["']|["']$/g, "");
    } else if (key && /^\s+\S/.test(line)) buf.push(line.trim());
    else flush();
  }
  flush();
  return out;
}

/** Recursively find SKILL.md files (depth-limited). */
function findSkillFiles(dir, depth = 4, acc = []) {
  if (depth < 0 || !existsSync(dir)) return acc;
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    if (e.startsWith(".git") || e === "node_modules") continue;
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) findSkillFiles(p, depth - 1, acc);
    else if (/^skill\.md$/i.test(e)) acc.push(p);
  }
  return acc;
}

export function defaultDirs() {
  const dirs = [
    join(homedir(), ".claude", "skills"),
    join(homedir(), ".claude", "plugins"),   // marketplace/plugin-installed skills
    join(process.cwd(), ".claude", "skills"),
    join(process.cwd(), "skills"),
  ];
  if (process.env.MISFIRE_DIRS)
    dirs.push(...process.env.MISFIRE_DIRS.split(",").map((s) => s.trim()));
  return dirs.filter(existsSync);
}

export function loadSkills(dirs) {
  const files = [...new Set(dirs.flatMap((d) => findSkillFiles(d)))];
  const skills = [];
  for (const f of files) {
    let md; try { md = readFileSync(f, "utf8"); } catch { continue; }
    const fm = parseFrontmatter(md);
    const name = fm.name || basename(join(f, ".."));
    const description = fm.description || "";
    skills.push({
      name, description, file: f,
      bodyTokens: estTokens(md),
      descTokens: estTokens(name + description),
      words: terms(description),
    });
  }
  return skills;
}

// ---------- analyses -------------------------------------------------------

export function findCollisions(skills, threshold = 0.35) {
  const df = new Map();
  for (const s of skills) for (const w of new Set(s.words)) df.set(w, (df.get(w) || 0) + 1);
  const N = skills.length, out = [];
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const a = skills[i], b = skills[j];
    if (!a.words.length || !b.words.length) continue;
    const sim = cosine(a.words, b.words, df, N);
    if (sim >= threshold) {
      out.push({ a: a.name, b: b.name, sim: +sim.toFixed(3), shared: sharedBigrams(a.words, b.words).slice(0, 6) });
    }
  }
  return out.sort((x, y) => y.sim - x.sim);
}

export function budgetReport(skills, budget = 16000) {
  const rows = skills.map((s) => ({ name: s.name, descTokens: s.descTokens, bodyTokens: s.bodyTokens }))
    .sort((a, b) => b.descTokens - a.descTokens);
  const total = rows.reduce((n, r) => n + r.descTokens, 0);
  // Skills are loaded in discovery order; those past the budget line are at risk of silent drop.
  let acc = 0; const atRisk = [];
  for (const s of skills) { acc += s.descTokens; if (acc > budget) atRisk.push(s.name); }
  return { rows, total, budget, over: total > budget, atRisk };
}

export function fire(skills, prompt, top = 5) {
  const pWords = terms(prompt);
  const df = new Map();
  for (const s of skills) for (const w of new Set(s.words)) df.set(w, (df.get(w) || 0) + 1);
  const N = skills.length || 1;
  return skills
    .map((s) => {
      const sim = cosine(pWords, s.words, df, N);
      const hits = [...new Set(pWords.filter((w) => s.words.includes(w)))].slice(0, 8);
      return { name: s.name, score: +sim.toFixed(3), hits };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

export function suggestions(collisions) {
  return collisions.map(({ a, b, shared }) => {
    const phrase = shared[0] ? `"${shared[0]}"` : "their shared trigger phrases";
    return `• ${a} ↔ ${b}: add a disambiguation line to each description — e.g. "${a}: use for ${phrase}; do NOT use for tasks meant for ${b}" (and vice-versa). If one should never auto-fire, set disable-model-invocation: true in its frontmatter.`;
  });
}

// ---------- CLI ------------------------------------------------------------

function opt(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = rest.filter((a) => !a.startsWith("--") && process.argv[process.argv.indexOf(a) - 1]?.startsWith("--") !== true);
  const threshold = parseFloat(opt("threshold", "0.35"));
  const budget = parseInt(opt("budget", "16000"), 10);
  const top = parseInt(opt("top", "5"), 10);

  if (!cmd || ["-h", "--help", "help"].includes(cmd)) {
    console.log(`${bold("misfire")} — find out why your agent picks the wrong skill\n
  misfire scan   [dir ...]      full report: collisions + token budget
  misfire fire   "prompt" [dir] which skills match a prompt, ranked
  misfire budget [dir ...]      token footprint table
  misfire json   [dir ...]      full report as JSON (CI-friendly)\n
  --threshold 0.35   collision sensitivity   --budget 16000   token budget
  --top 5            matches shown by fire   --no-color       plain output`);
    process.exit(0);
  }

  const isFire = cmd === "fire";
  const prompt = isFire ? args[0] : null;
  if (isFire && !prompt) { console.error(red("fire needs a prompt: misfire fire \"deploy my site\"")); process.exit(2); }
  const dirArgs = (isFire ? args.slice(1) : args).filter(existsSync);
  const dirs = dirArgs.length ? dirArgs : defaultDirs();
  if (!dirs.length) {
    console.error(red("No skill directories found."));
    console.error(dim(`  Searched: ~/.claude/skills, ~/.claude/plugins, ./.claude/skills, ./skills`));
    console.error(dim(`  Pass one explicitly (misfire scan ./my-skills) or set MISFIRE_DIRS=dir1,dir2`));
    process.exit(2);
  }

  const skills = loadSkills(dirs);
  if (!skills.length) { console.error(red(`No SKILL.md files found under: ${dirs.join(", ")}`)); process.exit(2); }

  if (cmd === "fire") {
    console.log(`\n${bold("🔥 Trigger simulation")} for: ${cyn(prompt)}\n`);
    const ranked = fire(skills, prompt, top);
    if (!ranked.length) return console.log(dim("  Nothing matches — this prompt won't trigger any skill."));
    ranked.forEach((r, i) => {
      const bar = "█".repeat(Math.max(1, Math.round(r.score * 30)));
      console.log(`  ${i === 0 ? grn(bold(r.name)) : r.name}`);
      console.log(`    ${i === 0 ? grn(bar) : dim(bar)} ${r.score}  ${dim("matched: " + r.hits.join(", "))}\n`);
    });
    if (ranked.length > 1 && ranked[1].score > ranked[0].score * 0.8)
      console.log(yel(`  ⚠ Close call between ${ranked[0].name} and ${ranked[1].name} — expect mis-fires. Run 'scan' for fixes.`));
    return;
  }

  const collisions = findCollisions(skills, threshold);
  const bud = budgetReport(skills, budget);

  if (cmd === "json") {
    console.log(JSON.stringify({ skills: skills.map(({ words, ...s }) => s), collisions, budget: bud }, null, 2));
    process.exit(collisions.length || bud.over ? 1 : 0);
  }

  if (cmd === "budget" || cmd === "scan") {
    console.log(`\n${bold("📦 Token budget")} — ${skills.length} skills from ${dirs.length} dir(s)`);
    const shown = bud.rows.slice(0, 15);
    const w = Math.max(...shown.map((r) => r.name.length));
    for (const r of shown)
      console.log(`  ${r.name.padEnd(w)}  ${String(r.descTokens).padStart(5)} desc tok  ${dim(String(r.bodyTokens).padStart(6) + " body tok")}`);
    if (bud.rows.length > 15) console.log(dim(`  … and ${bud.rows.length - 15} more`));
    const pct = Math.round((bud.total / bud.budget) * 100);
    const line = `  Total descriptions: ${bud.total} / ${bud.budget} tokens (${pct}%)`;
    console.log(bud.over ? red(bold(line + "  — OVER BUDGET")) : pct > 80 ? yel(line) : grn(line));
    if (bud.atRisk.length)
      console.log(red(`  ⚠ At risk of silent drop (${bud.atRisk.length}): ${bud.atRisk.slice(0, 8).join(", ")}${bud.atRisk.length > 8 ? "…" : ""}`));
  }

  if (cmd === "scan") {
    console.log(`\n${bold("💥 Collisions")} ${dim(`(similarity ≥ ${threshold})`)}`);
    if (!collisions.length) console.log(grn("  None — your skill descriptions are cleanly separated."));
    for (const col of collisions) {
      console.log(`  ${red(bold(col.a))} ↔ ${red(bold(col.b))}  ${yel(col.sim)}`);
      if (col.shared.length) console.log(dim(`    shared phrases: ${col.shared.join(" · ")}`));
    }
    if (collisions.length) {
      console.log(`\n${bold("🔧 Suggested fixes")}`);
      for (const s of suggestions(collisions)) console.log("  " + s);
    }
    console.log("");
    promo();
    process.exit(collisions.length || bud.over ? 1 : 0);
  }

  if (cmd !== "budget") { console.error(red(`Unknown command: ${cmd}`)); process.exit(2); }
  promo();
}

// pathToFileURL makes this work on Windows too (file:///C:/... vs C:\...)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
