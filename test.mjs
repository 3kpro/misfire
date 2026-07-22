import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  estTokens, terms, cosine, sharedBigrams, parseFrontmatter,
  loadSkills, findCollisions, budgetReport, fire, suggestions,
} from "./misfire.mjs";

// ---- helpers --------------------------------------------------------------

function makeSkillDir(skills) {
  const root = mkdtempSync(join(tmpdir(), "skillscope-"));
  for (const [name, description, body = ""] of skills) {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`);
  }
  return root;
}

// ---- unit tests -----------------------------------------------------------

test("estTokens approximates chars/3.7", () => {
  assert.equal(estTokens(""), 0);
  assert.equal(estTokens("a".repeat(37)), 10);
});

test("terms drops stopwords, numbers, short words", () => {
  const ws = terms("Use this skill to deploy the website with 42 zero-config CDN tools");
  assert.ok(ws.includes("deploy") && ws.includes("website") && ws.includes("cdn"));
  assert.ok(!ws.includes("use") && !ws.includes("the") && !ws.includes("42") && !ws.includes("to"));
});

test("cosine: identical texts ≈ 1, disjoint = 0", () => {
  const df = new Map();
  const a = terms("deploy website production server");
  const b = terms("bake chocolate cake frosting");
  for (const w of new Set([...a, ...b])) df.set(w, 1);
  assert.ok(cosine(a, a, df, 2) > 0.99);
  assert.equal(cosine(a, b, df, 2), 0);
});

test("sharedBigrams finds common phrases", () => {
  const g = sharedBigrams(terms("create word document files"), terms("edit word document layout"));
  assert.deepEqual(g, ["word document"]);
});

test("parseFrontmatter: single-line and multi-line values", () => {
  const single = parseFrontmatter(`---\nname: pdf\ndescription: Work with PDF files\n---\nbody`);
  assert.equal(single.name, "pdf");
  assert.equal(single.description, "Work with PDF files");

  const multi = parseFrontmatter(`---\nname: docx\ndescription: >-\n  Create Word documents\n  with rich formatting\n---\n`);
  assert.equal(multi.description, "Create Word documents with rich formatting");

  assert.deepEqual(parseFrontmatter("no frontmatter here"), {});
});

// ---- integration tests ----------------------------------------------------

test("loadSkills discovers and parses SKILL.md files", () => {
  const dir = makeSkillDir([
    ["deploy", "Deploy static websites to production hosting"],
    ["pdf", "Read, merge and create PDF documents"],
  ]);
  const skills = loadSkills([dir]);
  assert.equal(skills.length, 2);
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ["deploy", "pdf"]);
  assert.ok(skills.every((s) => s.descTokens > 0 && s.words.length > 0));
});

test("findCollisions flags near-duplicate descriptions, not distinct ones", () => {
  const dir = makeSkillDir([
    ["seo-audit-a", "Run a comprehensive SEO audit on a website to find SEO issues and ranking problems"],
    ["seo-audit-b", "Audit a website for SEO issues, ranking problems, and technical SEO health"],
    ["pdf", "Read, merge, split and create PDF documents and fill PDF forms"],
  ]);
  const skills = loadSkills([dir]);
  const cols = findCollisions(skills, 0.35);
  assert.equal(cols.length, 1);
  assert.deepEqual([cols[0].a, cols[0].b].sort(), ["seo-audit-a", "seo-audit-b"]);
  assert.ok(cols[0].sim > 0.5);
  // suggestions are generated for each collision
  assert.equal(suggestions(cols).length, 1);
  assert.match(suggestions(cols)[0], /disambiguation/);
});

test("budgetReport totals tokens and flags over-budget skills", () => {
  const dir = makeSkillDir([
    ["big", "x ".repeat(400)],   // ~800 chars desc
    ["small", "tiny description"],
  ]);
  const skills = loadSkills([dir]);
  const over = budgetReport(skills, 50);   // absurdly small budget
  assert.ok(over.total > 50);
  assert.ok(over.over);
  assert.ok(over.atRisk.length >= 1);
  const fine = budgetReport(skills, 100000);
  assert.ok(!fine.over);
  assert.equal(fine.atRisk.length, 0);
});

test("fire ranks the right skill first and reports matched terms", () => {
  const dir = makeSkillDir([
    ["deploy", "Deploy static websites to production hosting with zero config"],
    ["pdf", "Read, merge and create PDF documents"],
    ["spreadsheet", "Create and edit Excel spreadsheets with formulas"],
  ]);
  const skills = loadSkills([dir]);
  const ranked = fire(skills, "deploy my website to production", 5);
  assert.equal(ranked[0].name, "deploy");
  assert.ok(ranked[0].hits.includes("deploy"));
  // unrelated prompt matches nothing
  assert.equal(fire(skills, "bake a chocolate cake").length, 0);
});

test("fire close-call scenario: two overlapping skills score similarly", () => {
  const dir = makeSkillDir([
    ["seo-audit-a", "Run a comprehensive SEO audit on a website"],
    ["seo-audit-b", "Audit a website for SEO issues and health"],
  ]);
  const skills = loadSkills([dir]);
  const ranked = fire(skills, "audit my website SEO", 5);
  assert.equal(ranked.length, 2);
  assert.ok(ranked[1].score > ranked[0].score * 0.5, "both should score in the same range");
});
