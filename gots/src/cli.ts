#!/usr/bin/env node
// gots — TypeScript-syntax -> Go transpiler.
//
//   gots build <file.ts> [-o out.go]   transpile to .go (gofmt'd if available)
//   gots run   <file.ts> [args...]     transpile + `go run`
//   gots check <file.ts>               parse + typecheck syntax only
//
// The language is TypeScript syntax over Go's exact type system — write
// `let x: int32`, `m: map<string, int>`, `f(): [User, error]`, and the
// output is plain .go with zero runtime dependencies.

import ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { transpileFile } from "./emitter.ts";

const [cmd = "build", file, ...rest] = process.argv.slice(2);

if (!file || !fs.existsSync(file)) {
  console.error(`usage: gots build|run|check <file.ts|dir>`);
  process.exit(2);
}

// directory mode — .ts files under the dir (recursively) become sibling .go
// files; each subdirectory is its own Go package (multi-file projects:
// `gots build src/`, `gots run src/`)
if (fs.statSync(file).isDirectory()) {
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [p] : [];
    });
  const files = walk(file);
  if (!files.length) { console.error(`${file}: no .ts files`); process.exit(2); }
  let bad = 0;
  for (const f of files) {
    const { code, errors } = transpileFile(f, file);
    if (errors.length) { bad = 1; for (const e of errors) console.error(e); continue; }
    if (cmd === "check") continue;
    const out = f.replace(/\.ts$/, ".go");
    fs.writeFileSync(out, code);
    try { execFileSync("gofmt", ["-w", out]); } catch { }
    console.log(`wrote ${out}`);
  }
  if (bad) process.exit(1);
  if (cmd === "check") { console.log(`${file}: ok`); process.exit(0); }
  if (cmd === "run") {
    try { execSync(`go -C ${JSON.stringify(path.resolve(file))} run .`, { stdio: "inherit" }); }
    catch (e: any) { process.exit(e.status ?? 1); }
  }
  process.exit(0);
}

const { code, errors } = transpileFile(file);
if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}

if (cmd === "check") {
  console.log(`${file}: ok`);
  process.exit(0);
}

const outFlag = rest.indexOf("-o");
const out = outFlag >= 0 ? rest[outFlag + 1]
  : file.replace(/\.ts$/, ".go");

if (cmd === "build") {
  fs.writeFileSync(out, code);
  try { execFileSync("gofmt", ["-w", out]); } catch { /* gofmt optional */ }
  console.log(`wrote ${out}`);
  process.exit(0);
}

if (cmd === "run") {
  const dir = path.join(".gots-cache");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, path.basename(file).replace(/\.ts$/, ".go"));
  fs.writeFileSync(tmp, code);
  try { execFileSync("gofmt", ["-w", tmp]); } catch { }
  try {
    execSync(`go run ${JSON.stringify(tmp)}${rest.length ? " " + rest.join(" ") : ""}`, { stdio: "inherit" });
  } catch (e: any) {
    console.error(`--- transpiled output at ${tmp} ---`);
    process.exit(e.status ?? 1);
  }
  process.exit(0);
}

console.error(`unknown command: ${cmd}`);
process.exit(2);
