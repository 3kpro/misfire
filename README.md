# misfire

**Find out why your agent picks the wrong skill — before it does.**

> Not to be confused with [skillscope](https://www.npmjs.com/package/skillscope) (runtime observability — tells you which skills fired *after* the fact, via hooks). misfire is static analysis: it predicts collisions and mis-fires *before you ever run a session*, needs no hooks, no database, and works on skill packs you haven't installed yet. They're complementary.

You installed 40 skills. Your agent keeps grabbing the wrong one, or ignoring the right one entirely. Static linters check your frontmatter formatting; nobody tells you *which skills collide* or *which get silently dropped when your descriptions blow the context budget*. That's what misfire does.

```
npx misfire scan
```

Zero dependencies. One file. Node ≥ 18.

## What it catches

**💥 Collisions** — pairs of skills whose descriptions are similar enough that the model can fire the wrong one. Shows the exact shared trigger phrases causing it, and suggests disambiguation fixes ("use for X, do NOT use for Y", `disable-model-invocation: true`).

**📦 Budget drops** — total token footprint of your skill descriptions vs. the context budget. When you're over, skills get silently dropped before the model ever sees them — misfire tells you which ones are at risk.

**🔥 Trigger simulation** — `misfire fire "deploy my site"` ranks which of your installed skills match a prompt, shows the matched terms, and warns on close calls. Know the mis-fire before it happens.

## Usage

```bash
misfire scan                       # full report on ~/.claude/skills + ./.claude/skills
misfire scan ./my-plugin/skills    # any directory
misfire fire "make a slide deck"   # who fires for this prompt?
misfire budget --budget 12000      # token table with custom budget
misfire json                       # machine-readable, exits 1 on findings → CI gate
```

Add it to CI so a new skill can't land if it collides with an existing one:

```yaml
- run: npx misfire json ./skills
```

## Real output

```
💥 Collisions (similarity ≥ 0.35)
  algorithmic-art ↔ canvas-design  0.351
    shared phrases: create original · copying existing · artists work · avoid copyright

🔥 Trigger simulation for: make me a poster design with generative art
  canvas-design    ██████████ 0.336  matched: poster, design, art
  algorithmic-art  █████████  0.312  matched: generative, art
  ⚠ Close call — expect mis-fires.
```

## How it works

TF-IDF cosine similarity over skill descriptions (the text the model actually uses to pick skills), shared-bigram extraction for explainability, and a chars/3.7 token estimator accurate to ~10% for English prose. No API calls, no telemetry, runs entirely local.

## License

MIT

## Beyond linting — governing the agents

misfire tells you which skills *will* mis-fire. Once your agents are running for real, you'll want to know which ones actually *did* — and stop the destructive ones before they happen. That's [**Red Tape**](https://redtape.dev): enforced handoffs, protected-path guardrails, and a full audit trail for your AI agent fleet. misfire keeps your skills clean; Red Tape keeps your agents accountable.
