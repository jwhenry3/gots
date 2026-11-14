// gots — TypeScript-syntax to Go transpiler.
//
// The language is TypeScript syntax with Go's exact type system:
//   let x: int32, m: map<string, int>, fn: (e: error) => void, etc.
// Everything emits 1:1 into Go — no runtime, no FFI, plain .go output.

import ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolve as pathResolve, basename as pathBasename, dirname as pathDirname } from "node:path";
import { fileURLToPath } from "node:url";
// shared gots semantic rules — also used by plugin/index.cjs (tsserver)
import checks from "./checks.cjs";

export interface TranspileResult {
  code: string;
  errors: string[];
}

interface ClassInfo {
  hasCtor: boolean;
  statics: Set<string>; // static method + field names
  embeds?: string;      // `class B extends A` -> embedded *A
}

interface Ctx {
  sf: ts.SourceFile;
  file: string;
  errors: string[];
  checker?: ts.TypeChecker; // real TS checker — used when transpiling from a Program
  sfs?: ts.SourceFile[];    // all sibling files sharing the Go package
  uses: Set<string>;        // auto stdlib imports: "fmt", "os", ...
  classes: Map<string, ClassInfo>;
  enums: Set<string>;       // enum type names (members are package consts)
  varTypes: Map<string, string>; // declared Go types of vars/params in scope
  memberOf: Map<string, Set<string>>;    // type name -> member names (classes + interfaces)
  methodRets: Map<string, Map<string, string>>; // type name -> method -> Go return type
  funcRets: Map<string, string>;         // top-level func name -> Go return type
  thisType?: string;                     // class being emitted (for `this.x`)
  retType?: ts.TypeNode;    // enclosing function's declared return type
  inFunc: number;
  // decorator metadata (NestJS-style — erased at emit, drives framework wiring)
  ctrls: Map<string, CtrlMeta>;     // @Controller classes
  modules: Map<string, ModMeta>;    // @Module classes
  injectables: Set<string>;         // @Injectable classes (need NewX for DI)
  nestAlias?: string;               // local alias the "nestgo/nest" import bound to
  // multi-package support: each source dir is a Go package
  pkg: string;                      // Go package name of this file ("main" at build root)
  rootDir: string;                  // the build root — files there emit `package main`
  pkgPath: Map<string, string>;     // Go package name -> import path ("users" -> "gonest/src/users")
  aliasOf: Map<string, string>;     // local ident -> qualified emit name ("ConfigService" -> "core.ConfigService")
  // call-site default-param padding + accessor rewriting
  funcDefaults: Map<string, (ts.Expression | undefined)[]>;          // fn -> per-param defaults
  methodDefaults: Map<string, Map<string, (ts.Expression | undefined)[]>>; // cls -> method -> defaults
  getterOf: Map<string, Set<string>>; // cls -> get-accessor prop names
  setterOf: Map<string, Set<string>>; // cls -> set-accessor prop names
  consts: Set<string>;              // names declared `const` (Go const-expr eligibility)
  tmpN: number;                     // synthesized temp vars (__t0, __t1...)
}

interface CtrlMeta {
  prefix: string;
  guards: ts.Expression[];        // @UseGuards args — class idents or `new` exprs
  interceptors: ts.Expression[];  // @UseInterceptors args
  routes: { verb: string; path: string; method: string; guards: ts.Expression[]; interceptors: ts.Expression[] }[];
}

interface ModMeta {
  imports: string[];
  controllers: string[];
  providers: string[];
  exports: string[];
}

const ROUTE_DECORATORS = new Set(["Get", "Post", "Put", "Patch", "Delete", "Options", "Head", "All"]);

// --- package-qualification helpers -------------------------------------------

// local ident -> emitted name: imported symbols resolve to `pkg.Name`
function qname(ctx: Ctx, name: string): string { return ctx.aliasOf.get(name) ?? name; }

// package prefix ("core.") for a named decl — used when composing generated
// names like NewX / (*X).M that aliasOf can't resolve directly
function pkgPrefixOf(ctx: Ctx, name: string): string {
  const a = ctx.aliasOf.get(name);
  const dot = a ? a.lastIndexOf(".") : -1;
  return a && dot >= 0 ? a.slice(0, dot + 1) : "";
}
// generated New<Name> constructor, package-qualified
function qNew(ctx: Ctx, name: string): string { return pkgPrefixOf(ctx, name) + "New" + name; }

// memberOf / methodRets are keyed by bare type name — strip any pkg qualifier
function baseType(t: string): string {
  const dot = t.lastIndexOf(".");
  return dot >= 0 ? t.slice(dot + 1) : t;
}

// ---------- JS-semantics helpers (??, ?., ||, &&, typeof, truthiness) ---------

const NUMERIC_RE = /^(u?int(8|16|32|64)?|byte|rune|float32|float64|complex64|complex128|uintptr)$/;

function isNilableGo(t: string): boolean {
  return t === "any" || t === "error" || t.startsWith("*") || t.startsWith("[]") ||
    t.startsWith("map[") || t.startsWith("chan ") || t.startsWith("func(") ||
    t.startsWith("interface") || t === "nil";
}

function zeroValueOf(t: string): string {
  if (t === "bool") return "false";
  if (t === "string") return `""`;
  if (isNilableGo(t)) return "nil";
  if (NUMERIC_RE.test(t)) return "0";
  return `${t}{}`; // struct / array zero literal
}

// raw (unstripped) Go type of an expression — scope tables first, then the
// real checker; unlike typeNameOf this keeps leading * / [] so we can tell
// nilable from value types
function rawGoType(ctx: Ctx, e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) { const t = ctx.varTypes.get(e.text); if (t) return t; }
  return checkedGoType(ctx, e);
}

// the checker's type with null/undefined/void members removed from unions —
// for flag checks (BooleanLike etc.) on operands whose Go type is ambiguous
function tsRealType(ctx: Ctx, e: ts.Expression): ts.Type | undefined {
  if (!ctx.checker) return undefined;
  try {
    const t = ctx.checker.getTypeAtLocation(e);
    if (t.isUnion()) return t.types.find(x =>
      !(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void))) ?? t;
    return t;
  } catch { return undefined; }
}

// JS truthiness -> Go zero-value comparison: `a` (bool), `a != 0` (numbers),
// `a != ""` (strings), `a != nil` (pointers/slices/maps/chans/any)
function truthy(ctx: Ctx, e: ts.Expression): string {
  const ee = ex(ctx, e);
  const lt = rawGoType(ctx, e);
  if (lt === "bool") return ee;
  if (lt === "string") return `${ee} != ""`;
  if (lt && NUMERIC_RE.test(lt)) return `${ee} != 0`;
  const t = tsRealType(ctx, e);
  if (t) {
    if (t.flags & ts.TypeFlags.BooleanLike) return ee;
    if (t.flags & ts.TypeFlags.NumberLike) return `${ee} != 0`;
    if (t.flags & ts.TypeFlags.StringLike) return `${ee} != ""`;
  }
  return `${ee} != nil`;
}

// `a?.<tail>` — nil-guarded IIFE; mkTail maps the receiver text to the full
// expression so calls/elements/property chains all share the same shape.
// Non-nilable receivers skip the guard (Go value types can't be nil).
function optChain(ctx: Ctx, recv: ts.Expression, mkTail: (r: string) => string,
    want?: ts.TypeNode, eForType?: ts.Expression): string {
  const lt = rawGoType(ctx, recv);
  if (lt && !isNilableGo(lt)) return mkTail(ex(ctx, recv));
  const rt = want ? emitType(ctx, want) : (eForType && checkedGoType(ctx, eForType)) ?? "any";
  return `(func() ${rt} {\n__q := ${ex(ctx, recv)}\nif __q == nil {\nreturn ${zeroValueOf(rt)}\n}\nreturn ${mkTail("__q")}\n})()`;
}

// JS falsiness — `!truthy` rendered idiomatically (`x == nil`, `x == 0`, `!ok`)
function falsy(ctx: Ctx, e: ts.Expression): string {
  const t = truthy(ctx, e);
  const i = t.lastIndexOf(" != ");
  if (i >= 0) return t.slice(0, i) + " == " + t.slice(i + 4);
  return `!(${t})`;
}

// the receiver + tail of a `?.` chain, when the LHS of `??` is itself an
// optional access — lets `a?.b ?? c` fuse into one nil-check instead of
// collapsing through the zero value
function qdLeft(ctx: Ctx, e: ts.Expression): { recv: ts.Expression; tail: (r: string) => string } | undefined {
  if (ts.isPropertyAccessExpression(e) && e.questionDotToken)
    return { recv: e.expression, tail: r => `${r}.${memberName(ctx, e.expression, e.name.text)}` };
  if (ts.isElementAccessExpression(e) && e.questionDotToken)
    return { recv: e.expression, tail: r => `${r}[${ex(ctx, e.argumentExpression)}]` };
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.questionDotToken) {
    const pa = e.expression;
    return { recv: pa.expression, tail: r =>
      `${r}.${memberName(ctx, pa.expression, pa.name.text)}(${padArgs(ctx, e, methodDefsOf(ctx, pa.expression, pa.name.text))})` };
  }
  return undefined;
}

class W {
  lines: string[] = [];
  depth = 0;
  w(s = "") { this.lines.push("  ".repeat(this.depth) + s); }
  open(s: string) { this.w(s + " {"); this.depth++; }
  close() { this.depth--; this.w("}"); }
  text() { return this.lines.join("\n"); }
}

const GO_TYPES = new Set([
  "int", "int8", "int16", "int32", "int64",
  "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
  "float32", "float64", "complex64", "complex128",
  "byte", "rune", "string", "bool", "error", "any", "void",
]);

// PascalCase aliases for Go types — Float64 -> float64, Int32 -> int32, ...
// (`String`/`Number`/`Boolean` are skipped: they'd collide with TS's
// wrapper-object globals; the `string`/`number`/`boolean` keywords already
// map correctly.)
const GO_TYPE_ALIASES: Record<string, string> = {
  Int: "int", Int8: "int8", Int16: "int16", Int32: "int32", Int64: "int64",
  Uint: "uint", Uint8: "uint8", Uint16: "uint16", Uint32: "uint32", Uint64: "uint64",
  Uintptr: "uintptr", Float32: "float32", Float64: "float64",
  Complex64: "complex64", Complex128: "complex128",
  Byte: "byte", Rune: "rune", Bool: "bool", Any: "any", Error: "error",
};

// Go integer type names (INT_TYPES), isFloatLiteralText, unwrapCast —
// imported from src/checks.cjs, shared with the tsserver plugin.

const GO_BUILTINS = new Set([
  "append", "cap", "clear", "close", "complex", "copy", "delete",
  "imag", "len", "make", "new", "panic", "print", "println", "real", "recover",
]);

function hasMod(n: ts.Node, k: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some(m => m.kind === k);
}

// transpileFile builds a real ts.Program — the genuine TypeScript checker
// resolves types and reports semantic errors (branded numeric types make
// `let x: Int32 = 3` a real compile error, not just an IDE squiggle).
export function transpileFile(file: string, rootDir?: string): TranspileResult {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const abs = path.resolve(file);
  const buildRoot = path.resolve(rootDir ?? path.dirname(abs));
  // all .ts under the build root — subdirs become separate Go packages whose
  // types/members still share one checker program and member tables
  const siblings = collectTsFiles(buildRoot);
  // `types/` next to the build root — e.g. nestgo/types for nestgo/src
  const localTypes = path.join(buildRoot, "..", "types");
  const typeFiles = [
    ...["gots.d.ts", "stdlib.d.ts"].map(f => path.join(root, "types", f)),
    ...(fs.existsSync(localTypes)
      ? fs.readdirSync(localTypes).filter(f => f.endsWith(".d.ts")).map(f => path.join(localTypes, f))
      : []),
  ].filter(f => fs.existsSync(f));
  const roots = [...new Set([abs, ...siblings, ...typeFiles])];
  const program = ts.createProgram(roots, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: false, noEmit: true, skipLibCheck: true,
    types: ["node"], typeRoots: [path.join(root, "node_modules", "@types")],
  });
  const sf = program.getSourceFile(path.resolve(file));
  if (!sf) return { code: "", errors: [`${file}: could not load source file`] };
  // each subdirectory is a Go package — import path = <go.mod module>/<relpath>
  const gomod = findGoModule(buildRoot);
  const pkgPath = new Map<string, string>();
  for (const f of siblings) {
    const d = path.dirname(f);
    if (d === buildRoot) continue;
    const pkg = path.basename(d);
    if (!pkgPath.has(pkg)) {
      const rel = gomod ? path.relative(gomod.dir, d).split(path.sep).join("/") : pkg;
      pkgPath.set(pkg, gomod?.module ? `${gomod.module}/${rel}` : rel);
    }
  }
  return run(sf, file, program.getTypeChecker(),
    [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]
      .filter(d => !SUPPRESSED_DIAG_CODES.has(d.code)),
    program.getSourceFiles().filter(f => !f.isDeclarationFile), buildRoot, pkgPath);
}

// TS "always truthy/falsy/nullish" lints — gots implements ??, ?., ||, &&,
// and ??= natively, so constant-operand warnings are intentional code
const SUPPRESSED_DIAG_CODES = new Set([
  2869, // Right operand of ?? is unreachable because the left operand is never nullish
  2870, // This kind of expression is always nullish
  2871, // This kind of expression is always nullish
  2872, // This kind of expression is always truthy
  2873, // This kind of expression is always falsy
]);

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable dirs (permissions) are skipped, not fatal
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectTsFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function findGoModule(startDir: string): { dir: string; module: string } | undefined {
  let d = startDir;
  for (;;) {
    const gomod = path.join(d, "go.mod");
    if (fs.existsSync(gomod)) {
      const m = /^module\s+(\S+)/m.exec(fs.readFileSync(gomod, "utf8"));
      return { dir: d, module: m?.[1] ?? "" };
    }
    const parent = path.dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}

// transpileSource parses text without a Program — used by tests/playgrounds.
// Type resolution falls back to the emitter's own scope tables.
export function transpileSource(text: string, file: string): TranspileResult {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return run(sf, file, undefined, sf.parseDiagnostics ?? []);
}

function run(sf: ts.SourceFile, file: string, checker: ts.TypeChecker | undefined,
             diags: readonly ts.Diagnostic[], sfs?: ts.SourceFile[],
             rootDir?: string, pkgPath?: Map<string, string>): TranspileResult {
  const errors: string[] = [];
  for (const d of diags) {
    const { line, character } = ts.getLineAndCharacterOfPosition(sf, d.start ?? 0);
    const kind = d.category === ts.DiagnosticCategory.Error ? "error" : "warning";
    errors.push(`${file}:${line + 1}:${character + 1}: ${kind} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
  // gots-specific rules the TS checker can't see (literal values) —
  // shared with plugin/index.cjs so the editor reports the same errors.
  // Runs even when TS diagnostics exist — unsupported constructs (unions,
  // generators, export default...) should still flag alongside them.
  for (const d of (checks.allDiagnostics ?? checks.gotsDiagnostics)(sf)) {
    const { line, character } = ts.getLineAndCharacterOfPosition(sf, d.start);
    errors.push(`${file}:${line + 1}:${character + 1}: gots: ${d.messageText}`);
  }
  if (errors.length) return { code: "", errors };

  const fileDir = path.dirname(path.resolve(file));
  const buildRoot = rootDir ?? fileDir;
  const ctx: Ctx = {
    sf, file, errors, checker, sfs: sfs ?? [sf],
    uses: new Set(), classes: new Map(), enums: new Set(),
    varTypes: new Map(), memberOf: new Map(), methodRets: new Map(),
    funcRets: new Map(), inFunc: 0,
    ctrls: new Map(), modules: new Map(), injectables: new Set(),
    pkg: fileDir === buildRoot ? "main" : path.basename(fileDir),
    rootDir: buildRoot,
    pkgPath: pkgPath ?? new Map(),
    aliasOf: new Map(),
    funcDefaults: new Map(), methodDefaults: new Map(),
    getterOf: new Map(), setterOf: new Map(), consts: new Set(), tmpN: 0,
  };

  // pass 0 — enums, member tables (TS class/interface members are public ->
  // exported Go names), and top-level function return types — across ALL
  // sibling files, since they share the Go package's namespace.
  for (const st of ctx.sfs!.flatMap(f => f.statements)) {
    if (ts.isEnumDeclaration(st)) {
      ctx.enums.add(st.name.text);
      for (const m of st.members) ctx.consts.add(m.name.getText());
    }
    if (ts.isVariableStatement(st) && (st.declarationList.flags & ts.NodeFlags.Const)) {
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name)) ctx.consts.add(d.name.text);
    }
    if (ts.isInterfaceDeclaration(st)) {
      const members = new Set<string>();
      for (const m of st.members) if (m.name) members.add(m.name.getText());
      ctx.memberOf.set(st.name.text, members);
    }
    if (ts.isFunctionDeclaration(st) && st.name) {
      ctx.funcRets.set(st.name.text, st.type ? emitType(ctx, st.type, true) : "");
      ctx.funcDefaults.set(st.name.text, st.parameters.map(p => p.initializer));
    }
    if (ts.isClassDeclaration(st) && st.name) {
      const members = new Set<string>();
      const rets = new Map<string, string>();
      for (const m of st.members) {
        if ((ts.isPropertyDeclaration(m) || ts.isMethodDeclaration(m)) && m.name &&
            !hasMod(m, ts.SyntaxKind.StaticKeyword)) {
          const mn = m.name.getText();
          members.add(mn);
          if (ts.isMethodDeclaration(m)) rets.set(mn, m.type ? emitType(ctx, m.type, true) : "");
        }
        if (ts.isGetAccessorDeclaration(m) && m.name) {
          const pn = m.name.getText();
          if (!hasMod(m, ts.SyntaxKind.StaticKeyword)) {
            members.add(pn);
            if (!ctx.getterOf.has(st.name!.text)) ctx.getterOf.set(st.name!.text, new Set());
            ctx.getterOf.get(st.name!.text)!.add(pn);
          }
        }
        if (ts.isSetAccessorDeclaration(m) && m.name) {
          const pn = m.name.getText();
          if (!hasMod(m, ts.SyntaxKind.StaticKeyword)) {
            members.add(pn);
            if (!ctx.setterOf.has(st.name!.text)) ctx.setterOf.set(st.name!.text, new Set());
            ctx.setterOf.get(st.name!.text)!.add(pn);
          }
        }
        if (ts.isMethodDeclaration(m) && m.name) {
          if (!ctx.methodDefaults.has(st.name!.text)) ctx.methodDefaults.set(st.name!.text, new Map());
          ctx.methodDefaults.get(st.name!.text)!.set(m.name.getText(), m.parameters.map(p => p.initializer));
        }
        if (ts.isConstructorDeclaration(m)) {
          // parameter properties (private x: T) are members too
          for (const p of m.parameters)
            if (ts.isIdentifier(p.name) && (ts.getModifiers(p) ?? []).length) members.add(p.name.text);
        }
      }
      ctx.memberOf.set(st.name.text, members);
      ctx.methodRets.set(st.name.text, rets);
      collectDecorators(ctx, st);
    }
  }

  // pass 1 — class metadata (constructor presence, static members, embedding)
  for (const st of ctx.sfs!.flatMap(f => f.statements)) {
    if (!ts.isClassDeclaration(st) || !st.name) continue;
    const info: ClassInfo = { hasCtor: false, statics: new Set() };
    for (const m of st.members) {
      if (ts.isConstructorDeclaration(m)) info.hasCtor = true;
      if ((ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) && hasMod(m, ts.SyntaxKind.StaticKeyword) && m.name) {
        info.statics.add(m.name.getText());
      }
    }
    const ext = st.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
    if (ext) info.embeds = ext.expression.getText();
    ctx.classes.set(st.name.text, info);
  }

  const w = new W();
  const imports: { alias: string; path: string; names?: string[] }[] = [];
  const mainBody: ts.Statement[] = [];
  let declaredMain = false;

  // pass 2 — emit
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) { collectImport(ctx, st, imports); continue; }
    if (ts.isExportDeclaration(st)) {
      // `export {A}` — fine, Go exports by case; `export *`/`* as default` — no equivalent
      if (!st.exportClause) fail(ctx, st, "'export *' is not supported — packages export by name capitalization");
      else for (const el of st.exportClause.elements)
        if (el.name.text === "default")
          fail(ctx, el, "gots has no default exports — the package itself is the default import");
      continue;
    }
    if (ts.isExportAssignment(st)) {
      // `export default <decl>` is a Class/FunctionDeclaration (not this node);
      // this is `export default <expr>` / `export =`
      fail(ctx, st, "'export default <expr>' is not supported — the package itself is the default import; export the value by name");
      continue;
    }
    if (isTopLevelDecl(st)) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === "main") declaredMain = true;
      emitTop(ctx, w, st);
      continue;
    }
    mainBody.push(st); // script-style top-level statements -> func main()
  }

  if (mainBody.length && declaredMain) {
    fail(ctx, sf, "top-level statements conflict with a declared main() — pick one");
  }
  if (mainBody.length) {
    w.w("");
    w.open("func main()");
    for (const st of mainBody) { emitComments(ctx, w, st); stmt(ctx, w, st); }
    w.close();
  }

  // header: package + merged imports (auto stdlib first, then user imports)
  const head = new W();
  head.w(`package ${ctx.pkg}`);
  head.w("");
  const autoImports = [...ctx.uses].sort();
  const havePath = new Set(imports.map(i => i.path));
  const norm = (i: { alias: string; path: string }) =>
    i.alias && i.alias !== i.path.split("/").pop() ? i : { alias: "", path: i.path };
  const body = w.text();
  const seen = new Set<string>();
  const allImports = [
    ...autoImports.filter(p => !havePath.has(p)).map(p => ({ alias: "", path: p })),
    ...imports.map(norm),
    // drop imports the emitted code never references (Go rejects unused imports)
  ].filter(i => importUsed(i, body))
   .filter(i => { const k = `${i.alias}:${i.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (allImports.length === 1) {
    const i = allImports[0];
    head.w(`import ${i.alias ? i.alias + " " : ""}"${i.path}"`);
  } else if (allImports.length) {
    head.w("import (");
    for (const i of allImports) head.w(`\t${i.alias ? i.alias + " " : ""}"${i.path}"`);
    head.w(")");
    head.w("");
  }

  if (errors.length) return { code: "", errors };
  return { code: head.text() + "\n" + body + "\n", errors };
}

// ---------- decorators (NestJS-style compile-time metadata) ----------

// decoratorName(d) -> "Get" for @Get("/") and bare @Get
function decoratorName(d: ts.Decorator): string {
  const e = d.expression;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
  if (ts.isIdentifier(e)) return e.text;
  return "";
}
function decoratorArgs(d: ts.Decorator): ts.Expression[] {
  return ts.isCallExpression(d.expression) ? [...d.expression.arguments] : [];
}
function strArg(e: ts.Expression | undefined): string {
  return e && ts.isStringLiteral(e) ? e.text : "";
}
// classRef arg -> Go provider-constructor func name (NewX)
function refName(e: ts.Expression): string {
  return ts.isIdentifier(e) ? e.text : "";
}
// guard/interceptor arg -> Go instance expression: `new X()` passthrough,
// class ident -> NewX() (ctor) or &X{} (plain struct)
function instExpr(ctx: Ctx, e: ts.Expression): string {
  if (ts.isNewExpression(e)) return ex(ctx, e);
  if (ts.isIdentifier(e)) {
    const name = e.text;
    return (ctx.classes.get(name)?.hasCtor || ctx.injectables.has(name)) ? `${qNew(ctx, name)}()` : `&${qname(ctx, name)}{}`;
  }
  return ex(ctx, e);
}

function collectDecorators(ctx: Ctx, cls: ts.ClassDeclaration) {
  const name = cls.name?.text;
  if (!name) return;
  for (const d of ts.getDecorators(cls) ?? []) {
    const dn = decoratorName(d);
    const args = decoratorArgs(d);
    if (dn === "Controller") {
      const meta = ctx.ctrls.get(name) ?? { prefix: "/", guards: [], interceptors: [], routes: [] };
      meta.prefix = strArg(args[0]) || "/";
      ctx.ctrls.set(name, meta);
    } else if (dn === "Injectable") {
      ctx.injectables.add(name);
    } else if (dn === "Module") {
      const meta: ModMeta = { imports: [], controllers: [], providers: [], exports: [] };
      const obj = args[0];
      if (obj && ts.isObjectLiteralExpression(obj)) {
        for (const p of obj.properties) {
          const key = p.name && ts.isIdentifier(p.name) ? p.name.text : "";
          if (!ts.isPropertyAssignment(p) || !ts.isArrayLiteralExpression(p.initializer)) continue;
          const idents = p.initializer.elements.map(refName).filter(Boolean);
          if (key === "imports") meta.imports.push(...idents);
          else if (key === "controllers") meta.controllers.push(...idents);
          else if (key === "providers") meta.providers.push(...idents);
          else if (key === "exports") meta.exports.push(...idents);
        }
      }
      ctx.modules.set(name, meta);
      ctx.injectables.add(name); // module class ident -> NewX() in expression position
    } else if (dn === "UseGuards" || dn === "UseInterceptors") {
      const meta = ctx.ctrls.get(name) ?? { prefix: "/", guards: [], interceptors: [], routes: [] };
      if (dn === "UseGuards") meta.guards.push(...args); else meta.interceptors.push(...args);
      ctx.ctrls.set(name, meta);
    }
  }
  // method decorators -> route table for the controller meta (class-level
  // @Controller may appear after/before method scan — fill routes regardless)
  const meta = ctx.ctrls.get(name);
  if (!meta) return;
  for (const m of cls.members) {
    if (!ts.isMethodDeclaration(m) || !m.name) continue;
    const route = { verb: "", path: "", method: "", guards: [] as ts.Expression[], interceptors: [] as ts.Expression[] };
    for (const d of ts.getDecorators(m) ?? []) {
      const dn = decoratorName(d);
      const args = decoratorArgs(d);
      if (ROUTE_DECORATORS.has(dn)) {
        route.verb = dn; route.path = strArg(args[0]) || "/"; route.method = m.name.getText();
      } else if (dn === "UseGuards") route.guards.push(...args);
      else if (dn === "UseInterceptors") route.interceptors.push(...args);
    }
    if (route.verb) meta.routes.push(route);
  }
}

// emitModuleFactory: @Module({...}) class X -> func NewX() *nest.Module
function emitModuleFactory(ctx: Ctx, w: W, name: string, meta: ModMeta, nestRef: string) {
  const ctrlExpr = (c: string): string => {
    const m = ctx.ctrls.get(c);
    let s = `${nestRef}.Controller("${m?.prefix ?? "/"}", ${qNew(ctx, c)})`;
    if (m?.guards.length) s += `.Guards(${m.guards.map(g => instExpr(ctx, g)).join(", ")})`;
    if (m?.interceptors.length) s += `.Interceptors(${m.interceptors.map(i => instExpr(ctx, i)).join(", ")})`;
    for (const r of m?.routes ?? []) {
      const opts = [
        ...r.guards.map(g => `${nestRef}.WithGuard(${instExpr(ctx, g)})`),
        ...r.interceptors.map(i => `${nestRef}.WithInterceptor(${instExpr(ctx, i)})`),
      ];
      s += `.${r.verb}("${r.path}", (*${pkgPrefixOf(ctx, c)}${c}).${cap(r.method)}${opts.length ? ", " + opts.join(", ") : ""})`;
    }
    return s;
  };
  const chain: string[] = [`${nestRef}.NewModule("${name}")`];
  if (meta.imports.length) chain.push(`Imports(${meta.imports.map(i => `${qNew(ctx, i)}()`).join(", ")})`);
  if (meta.controllers.length) chain.push(`Controllers(${meta.controllers.map(ctrlExpr).join(",\n\t\t\t")})`);
  if (meta.providers.length) chain.push(`Providers(${meta.providers.map(p => qNew(ctx, p)).join(", ")})`);
  if (meta.exports.length) chain.push(`Exports(${meta.exports.map(p => qNew(ctx, p)).join(", ")})`);
  w.open(`func New${name}() *${nestRef}.Module`);
  w.w(`return ${chain.join(".\n\t\t")}`);
  w.close();
  w.w("");
}

function isTopLevelDecl(st: ts.Statement): boolean {
  return ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) ||
    ts.isInterfaceDeclaration(st) || ts.isEnumDeclaration(st) ||
    ts.isTypeAliasDeclaration(st) || ts.isVariableStatement(st) ||
    st.kind === ts.SyntaxKind.EmptyStatement;
}

function fail(ctx: Ctx, node: ts.Node, msg: string) {
  const { line, character } = ts.getLineAndCharacterOfPosition(ctx.sf, node.getStart(ctx.sf));
  ctx.errors.push(`${ctx.file}:${line + 1}:${character + 1}: ${msg}`);
}

function emitComments(ctx: Ctx, w: W, node: ts.Node) {
  const ranges = ts.getLeadingCommentRanges(ctx.sf.text, node.getFullStart()) ?? [];
  for (const r of ranges) {
    for (const line of ctx.sf.text.slice(r.pos, r.end).split("\n")) {
      w.w(line.trimEnd());
    }
  }
}

// ---------- types ----------

function emitType(ctx: Ctx, tn: ts.TypeNode | undefined | null, inReturn = false, inTypeArg = false): string {
  if (!tn) return inReturn ? "" : "any";
  switch (tn.kind) {
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.UnknownKeyword: return "any";
    case ts.SyntaxKind.BooleanKeyword: return "bool";
    case ts.SyntaxKind.NumberKeyword: return "float64";
    case ts.SyntaxKind.StringKeyword: return "string";
    case ts.SyntaxKind.VoidKeyword:
    case ts.SyntaxKind.NeverKeyword: return "";
    case ts.SyntaxKind.ObjectKeyword: return "any";
    case ts.SyntaxKind.ParenthesizedType:
      return emitType(ctx, (tn as ts.ParenthesizedTypeNode).type, inReturn);
    case ts.SyntaxKind.ArrayType:
      return "[]" + emitType(ctx, (tn as ts.ArrayTypeNode).elementType);
    case ts.SyntaxKind.TypeReference: {
      const tr = tn as ts.TypeReferenceNode;
      const name = tr.typeName.getText();
      const args = tr.typeArguments ?? [];
      if ((name === "Array") && args.length === 1) return "[]" + emitType(ctx, args[0]);
      if ((name === "Map" || name === "map") && args.length === 2) return `map[${emitType(ctx, args[0])}]${emitType(ctx, args[1])}`;
      if ((name === "Channel" || name === "Chan" || name === "chan") && args.length === 1) return "chan " + emitType(ctx, args[0]);
      if ((name === "Ptr" || name === "ptr") && args.length === 1) {
        const inner = emitType(ctx, args[0]);
        return inner.startsWith("*") ? inner : "*" + inner; // classes already emit *T
      }
      if (name === "Promise" && args.length === 1) return emitType(ctx, args[0]);
      if (name === "undefined" || name === "null") return "any";
      const qn = qname(ctx, name); // cross-package imported type -> pkg.Name
      if (args.length) return `${qn}[${args.map(a => emitType(ctx, a)).join(", ")}]`;
      // class types are reference types in TS -> always pointers in Go;
      // except inside generic instantiation args, where T binds to the name
      // itself (Inject<ConfigService> -> Inject[ConfigService] returns *T)
      if (!inTypeArg && ctx.classes.has(name)) return "*" + qn;
      if (name in GO_TYPE_ALIASES) return GO_TYPE_ALIASES[name];
      return qn; // int, int32, error, User, ... — Go names pass through 1:1
    }
    case ts.SyntaxKind.FunctionType:
      return emitFuncType(ctx, tn as ts.FunctionTypeNode);
    case ts.SyntaxKind.TypeLiteral:
      return emitTypeLiteral(ctx, tn as ts.TypeLiteralNode);
    case ts.SyntaxKind.TupleType: {
      if (!inReturn) {
        fail(ctx, tn, "tuple types are only supported as return types: f(): [T, error]");
        return "any";
      }
      return "(" + (tn as ts.TupleTypeNode).elements.map(e => emitType(ctx, e)).join(", ") + ")";
    }
    case ts.SyntaxKind.UnionType: {
      // T | null / T | undefined  ->  *T  (Go's nullable form)
      const parts = (tn as ts.UnionTypeNode).types;
      const nonNil = parts.filter(p => {
        const t = p.getText();
        return t !== "null" && t !== "undefined" && p.kind !== ts.SyntaxKind.UndefinedKeyword && p.kind !== ts.SyntaxKind.NullKeyword;
      });
      if (nonNil.length === 1 && nonNil.length !== parts.length) return "*" + emitType(ctx, nonNil[0]);
      fail(ctx, tn, "unions are not supported except 'T | null' -> *T (Go has no union types)");
      return "any";
    }
    case ts.SyntaxKind.LiteralType: {
      const lit = (tn as ts.LiteralTypeNode).literal;
      if (ts.isStringLiteral(lit)) return "string";
      if (ts.isNumericLiteral(lit)) return "float64";
      if (lit.kind === ts.SyntaxKind.TrueKeyword || lit.kind === ts.SyntaxKind.FalseKeyword) return "bool";
      return "any";
    }
    case ts.SyntaxKind.IndexedAccessType:
      fail(ctx, tn, "indexed access types are not supported");
      return "any";
    case ts.SyntaxKind.TypeOperator:
      fail(ctx, tn, "type operators (keyof/readonly/unique) are not supported");
      return "any";
    case ts.SyntaxKind.OptionalType:
      return emitType(ctx, (tn as ts.OptionalTypeNode).type);
    default:
      fail(ctx, tn, `unsupported type syntax: ${ts.SyntaxKind[tn.kind]}`);
      return "any";
  }
}

function emitParam(ctx: Ctx, p: ts.ParameterDeclaration, dropName = false, idx = 0): string {
  if (!ts.isIdentifier(p.name)) {
    // destructured param -> a synthetic positional arg, unpacked at body top
    return `__p${idx} ${p.type ? emitType(ctx, p.type) : "any"}`;
  }
  const name = dropName ? "" : p.name.text + " ";
  if (p.dotDotDotToken) return name + "..." + emitType(ctx, elemOf(p.type));
  if (p.questionToken) return name + "*" + emitType(ctx, p.type);
  // defaults are dropped from the signature — callers pad them at the call site
  return name + emitType(ctx, p.type ?? undefined);
}

function elemOf(t?: ts.TypeNode): ts.TypeNode | undefined {
  return t && ts.isArrayTypeNode(t) ? t.elementType : t;
}

function emitParams(ctx: Ctx, params: ts.NodeArray<ts.ParameterDeclaration> | ts.ParameterDeclaration[]): string {
  return [...params].map((p, i) => emitParam(ctx, p, false, i)).join(", ");
}

// destructured params become `__pN` — unpack them to locals at the top of
// the body: `f({a, b}: T)` -> `a, b := __p0.A, __p0.B`
function emitParamDestructures(ctx: Ctx, w: W, params: readonly ts.ParameterDeclaration[]) {
  params.forEach((p, i) => {
    if (ts.isObjectBindingPattern(p.name)) {
      if (p.type) ctx.varTypes.set(`__p${i}`, emitType(ctx, p.type));
      for (const el of p.name.elements) {
        if (el.dotDotDotToken) { fail(ctx, el, "rest in destructured params is not supported"); continue; }
        if (el.initializer) { fail(ctx, el, "defaults in destructured params are not supported"); continue; }
        if (!ts.isIdentifier(el.name) || (el.propertyName && !ts.isIdentifier(el.propertyName))) {
          fail(ctx, el, "nested destructured params are not supported"); continue;
        }
        const prop = (el.propertyName ?? el.name).text;
        // type-literal params emit verbatim field names; named types go
        // through the member table so exported (capitalized) names win
        const pt = p.type ? emitType(ctx, p.type) : "";
        const propGo = p.type && ts.isTypeLiteralNode(p.type) ? prop
          : ctx.memberOf.get(baseType(pt))?.has(prop) ? cap(prop) : prop;
        w.w(`${el.name.text} := __p${i}.${propGo}`);
        const t = tsRealType(ctx, el.name as unknown as ts.Expression);
        if (t) { const g = goTypeName(ctx, ctx.checker!, t, el.name as unknown as ts.Expression); if (g) ctx.varTypes.set(el.name.text, g); }
      }
    } else if (ts.isArrayBindingPattern(p.name)) {
      if (p.type) ctx.varTypes.set(`__p${i}`, emitType(ctx, p.type));
      p.name.elements.forEach((el, j) => {
        if (ts.isOmittedExpression(el)) { w.w(`_ = __p${i}[${j}]`); return; }
        if (!ts.isIdentifier(el.name)) { fail(ctx, el, "nested destructured params are not supported"); return; }
        w.w(`${el.name.text} := __p${i}[${j}]`);
      });
    }
  });
}

function emitFuncType(ctx: Ctx, ft: ts.FunctionTypeNode | ts.MethodSignature): string {
  const ret = emitType(ctx, ft.type, true);
  return `func(${emitParams(ctx, ft.parameters)})${ret ? " " + ret : ""}`;
}

function emitTypeLiteral(ctx: Ctx, tl: ts.TypeLiteralNode): string {
  const parts: string[] = [];
  for (const m of tl.members) {
    if (ts.isPropertySignature(m) && m.name) {
      const t = m.questionToken ? "*" + emitType(ctx, m.type) : emitType(ctx, m.type);
      parts.push(`${m.name.getText()} ${t}`);
    } else if (ts.isMethodSignature(m) && m.name) {
      parts.push(`${m.name.getText()}${emitFuncType(ctx, m).replace(/^func/, "func")}`);
    } else if (ts.isIndexSignatureDeclaration(m)) {
      const kt = m.parameters[0]?.type ? emitType(ctx, m.parameters[0].type) : "string";
      const vt = m.type ? emitType(ctx, m.type) : "any";
      parts.push(`map[${kt}]${vt}`); // loose approximation
    }
  }
  return `struct { ${parts.join("; ")} }`;
}

function emitTypeParams(ctx: Ctx, tps: ts.NodeArray<ts.TypeParameterDeclaration> | undefined): string {
  if (!tps?.length) return "";
  const parts = tps.map(tp => {
    const c = tp.constraint ? emitType(ctx, tp.constraint) : "any";
    return `${tp.name.text} ${c === "" ? "any" : c}`;
  });
  return `[${parts.join(", ")}]`;
}

// ---------- statements ----------

function emitTop(ctx: Ctx, w: W, st: ts.Statement) {
  emitComments(ctx, w, st);
  if (st.kind === ts.SyntaxKind.EmptyStatement) return;
  if (ts.isVariableStatement(st)) { emitVar(ctx, w, st, true); return; }
  if (ts.isFunctionDeclaration(st)) { emitFunc(ctx, w, st, false); return; }
  if (ts.isClassDeclaration(st)) { emitClass(ctx, w, st); return; }
  if (ts.isInterfaceDeclaration(st)) { emitInterface(ctx, w, st); return; }
  if (ts.isEnumDeclaration(st)) { emitEnum(ctx, w, st); return; }
  if (ts.isTypeAliasDeclaration(st)) {
    w.w(`type ${st.name.text} = ${emitType(ctx, st.type)}`);
    return;
  }
  fail(ctx, st, `unsupported top-level statement: ${ts.SyntaxKind[st.kind]}`);
}

function stmt(ctx: Ctx, w: W, st: ts.Statement) {
  switch (st.kind) {
    case ts.SyntaxKind.VariableStatement:
      emitVar(ctx, w, st as ts.VariableStatement, false); return;
    case ts.SyntaxKind.FunctionDeclaration:
      emitFunc(ctx, w, st as ts.FunctionDeclaration, true); return;
    case ts.SyntaxKind.ExpressionStatement:
      emitExprStmt(ctx, w, (st as ts.ExpressionStatement).expression); return;
    case ts.SyntaxKind.ReturnStatement: {
      const r = st as ts.ReturnStatement;
      if (!r.expression) { w.w("return"); return; }
      if (ts.isArrayLiteralExpression(r.expression)) {
        w.w(`return ${r.expression.elements.map(e => ex(ctx, e)).join(", ")}`);
        return;
      }
      w.w(`return ${ex(ctx, r.expression, ctx.retType)}`); return;
    }
    case ts.SyntaxKind.IfStatement: {
      const n = st as ts.IfStatement;
      w.open(`if ${ex(ctx, n.expression)}`);
      emitBlockStmts(ctx, w, n.thenStatement);
      w.depth--;
      if (n.elseStatement) {
        if (ts.isIfStatement(n.elseStatement)) {
          // "} else if" — recurse by emitting the nested if inline
          const inner = n.elseStatement as ts.IfStatement;
          w.w(`} else if ${ex(ctx, inner.expression)} {`);
          w.depth++;
          emitBlockStmts(ctx, w, inner.thenStatement);
          w.depth--;
          // chain any further else/else-if
          let tail = inner.elseStatement;
          const stub = n as ts.IfStatement;
          while (tail) {
            if (ts.isIfStatement(tail)) {
              w.w(`} else if ${ex(ctx, tail.expression)} {`);
              w.depth++;
              emitBlockStmts(ctx, w, tail.thenStatement);
              w.depth--;
              tail = tail.elseStatement;
            } else {
              w.w("} else {");
              w.depth++;
              emitBlockStmts(ctx, w, tail);
              w.depth--;
              tail = undefined;
            }
          }
          void stub;
          w.w("}");
          return;
        }
        w.w("} else {");
        w.depth++;
        emitBlockStmts(ctx, w, n.elseStatement);
        w.depth--;
      }
      w.w("}"); return;
    }
    case ts.SyntaxKind.ForStatement: {
      const n = st as ts.ForStatement;
      const init = n.initializer ? forInit(ctx, n.initializer) : "";
      const cond = n.condition ? ex(ctx, n.condition) : "";
      const incr = n.incrementor ? ex(ctx, n.incrementor) : "";
      w.open(`for ${init}; ${cond}; ${incr}`);
      emitBlockStmts(ctx, w, n.statement);
      w.close(); return;
    }
    case ts.SyntaxKind.ForOfStatement: {
      const n = st as ts.ForOfStatement;
      if (n.awaitModifier) { fail(ctx, n, "'for await' is not supported — range over a channel"); return; }
      // ranging a channel takes one variable; slices/maps need the index slot
      const isChan = ts.isIdentifier(n.expression) &&
        (ctx.varTypes.get(n.expression.text) ?? "").startsWith("chan ");
      const bind = forOfBinding(ctx, n.initializer);
      w.open(`for ${isChan ? bind.replace(/^_, /, "") : bind} := range ${ex(ctx, n.expression)}`);
      emitBlockStmts(ctx, w, n.statement);
      w.close(); return;
    }
    case ts.SyntaxKind.ForInStatement: {
      const n = st as ts.ForInStatement;
      const v = bindingName(ctx, n.initializer);
      w.open(`for ${v} := range ${ex(ctx, n.expression)}`);
      emitBlockStmts(ctx, w, n.statement);
      w.close(); return;
    }
    case ts.SyntaxKind.WhileStatement: {
      const n = st as ts.WhileStatement;
      w.open(`for ${ex(ctx, n.expression)}`);
      emitBlockStmts(ctx, w, n.statement);
      w.close(); return;
    }
    case ts.SyntaxKind.DoStatement: {
      const n = st as ts.DoStatement;
      w.open("for");
      emitBlockStmts(ctx, w, n.statement);
      w.w(`if !(${ex(ctx, n.expression)}) { break }`);
      w.close(); return;
    }
    case ts.SyntaxKind.SwitchStatement: emitSwitch(ctx, w, st as ts.SwitchStatement); return;
    case ts.SyntaxKind.TryStatement: emitTry(ctx, w, st as ts.TryStatement); return;
    case ts.SyntaxKind.ThrowStatement: {
      const e = (st as ts.ThrowStatement).expression;
      if (ts.isNewExpression(e) && e.expression.getText() === "Error" && e.arguments?.length === 1) {
        w.w(`panic(${ex(ctx, e.arguments[0])})`);
      } else {
        w.w(`panic(${ex(ctx, e)})`);
      }
      return;
    }
    case ts.SyntaxKind.BreakStatement:
      w.w("break" + labelSuffix(st as ts.BreakStatement)); return;
    case ts.SyntaxKind.ContinueStatement:
      w.w("continue" + labelSuffix(st as ts.ContinueStatement)); return;
    case ts.SyntaxKind.LabeledStatement: {
      const n = st as ts.LabeledStatement;
      w.w(`${n.label.text}:`);
      stmt(ctx, w, n.statement); return;
    }
    case ts.SyntaxKind.Block:
      w.open("");
      for (const s of (st as ts.Block).statements) { emitComments(ctx, w, s); stmt(ctx, w, s); }
      w.close(); return;
    case ts.SyntaxKind.EmptyStatement: return;
    case ts.SyntaxKind.TypeAliasDeclaration:
    case ts.SyntaxKind.InterfaceDeclaration: return; // type-only, no code
    default:
      fail(ctx, st, `unsupported statement: ${ts.SyntaxKind[st.kind]}`);
  }
}

function labelSuffix(st: ts.BreakStatement | ts.ContinueStatement): string {
  return st.label ? " " + st.label.text : "";
}

function emitBlockStmts(ctx: Ctx, w: W, s: ts.Statement) {
  if (ts.isBlock(s)) {
    for (const inner of s.statements) { emitComments(ctx, w, inner); stmt(ctx, w, inner); }
  } else {
    emitComments(ctx, w, s);
    stmt(ctx, w, s);
  }
}

function emitVar(ctx: Ctx, w: W, st: ts.VariableStatement, topLevel: boolean) {
  const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
  // AwaitUsing is a mask (Const|Using) — the Using bit alone covers both
  if (st.declarationList.flags & ts.NodeFlags.Using) {
    fail(ctx, st, "'using' declarations are not supported — call Close() or defer it");
    return;
  }
  for (const d of st.declarationList.declarations) {
    // let [a, b] = f()  ->  a, b := f()   (Go multiple return values)
    if (ts.isArrayBindingPattern(d.name)) {
      if (!d.initializer) { fail(ctx, d, "destructuring needs an initializer"); continue; }
      const names = d.name.elements.map(el =>
        ts.isBindingElement(el) && ts.isIdentifier(el.name) ? el.name.text : "_");
      const rhs = ex(ctx, d.initializer);
      // a call returns multiple values; a slice/array/tuple var needs indexing
      if (ts.isCallExpression(d.initializer)) {
        w.w(`${names.join(", ")} := ${rhs}`);
      } else {
        const tmp = `__t${ctx.tmpN++}`;
        w.w(`${tmp} := ${rhs}`);
        names.forEach((n, i) => { if (n !== "_") w.w(`${n} := ${tmp}[${i}]`); });
      }
      continue;
    }
    // let {a, b} = obj  ->  a, b := obj.A, obj.B  (one temp so rhs evals once)
    if (ts.isObjectBindingPattern(d.name)) {
      if (!d.initializer) { fail(ctx, d, "destructuring needs an initializer"); continue; }
      const tmp = `__t${ctx.tmpN++}`;
      w.w(`${tmp} := ${ex(ctx, d.initializer)}`);
      for (const el of d.name.elements) {
        if (el.dotDotDotToken) { fail(ctx, el, "rest in destructuring is not supported"); continue; }
        if (el.initializer) { fail(ctx, el, "defaults in destructuring are not supported"); continue; }
        if (!ts.isIdentifier(el.name) || (el.propertyName && !ts.isIdentifier(el.propertyName))) {
          fail(ctx, el, "nested destructuring is not supported"); continue;
        }
        const prop = (el.propertyName ?? el.name).text;
        w.w(`${el.name.text} := ${tmp}.${memberName(ctx, d.initializer, prop)}`);
        const t = tsRealType(ctx, el.name as unknown as ts.Expression);
        if (t && ctx.checker) {
          const g = goTypeName(ctx, ctx.checker, t, el.name as unknown as ts.Expression);
          if (g) ctx.varTypes.set(el.name.text, g);
        }
      }
      continue;
    }
    if (!ts.isIdentifier(d.name)) { fail(ctx, d, "destructuring declarations are not supported"); continue; }
    const name = d.name.text;
    const typ = d.type ? emitType(ctx, d.type) : "";
    ctx.varTypes.set(name, typ || (d.initializer ? inferType(ctx, d.initializer) : ""));
    const init = d.initializer ? ex(ctx, d.initializer, d.type) : "";
    if (isConst) {
      if (!init) { fail(ctx, d, "const declarations need an initializer"); continue; }
      // Go const only holds constant expressions + typed consts can't be `any`
      if (isConstExpr(ctx, d.initializer!) && typ !== "any") {
        w.w(`const ${name}${typ ? " " + typ : ""} = ${init}`);
      } else {
        w.w(`var ${name}${typ ? " " + typ : ""} = ${init}`);
      }
    } else if (topLevel || typ || !init) {
      w.w(`var ${name}${typ ? " " + typ : ""}${init ? " = " + init : ""}`);
    } else {
      w.w(`${name} := ${init}`);
    }
  }
}

function emitFunc(ctx: Ctx, w: W, f: ts.FunctionDeclaration, nested: boolean) {
  if (!f.body) { fail(ctx, f, "overloads and 'declare' signatures are not supported — gots needs a body (declare belongs in .d.ts)"); return; }
  if (f.asteriskToken) { fail(ctx, f, "generator functions are not supported — use channels or slices"); return; }
  if (!f.name) { fail(ctx, f, "anonymous function declarations are not supported"); return; }
  const name = f.name.text;
  if (nested && f.typeParameters?.length) {
    fail(ctx, f, "generic nested functions are not supported (Go func literals can't be generic)");
  }
  const tps = emitTypeParams(ctx, f.typeParameters);
  const ret = emitType(ctx, f.type, true);
  const sig = `${tps}(${emitParams(ctx, f.parameters)})${ret ? " " + ret : ""}`;
  const prevRet = ctx.retType; ctx.retType = f.type; ctx.inFunc++;
  const prevVars = ctx.varTypes; ctx.varTypes = new Map(prevVars);
  for (const p of f.parameters) if (ts.isIdentifier(p.name) && p.type) ctx.varTypes.set(p.name.text, emitType(ctx, p.type));
  if (nested) w.open(`${name} := func${sig}`);
  else w.open(`func ${name}${sig}`);
  emitParamDestructures(ctx, w, f.parameters);
  if (f.body) for (const s of f.body.statements) { emitComments(ctx, w, s); stmt(ctx, w, s); }
  w.close();
  ctx.retType = prevRet; ctx.inFunc--; ctx.varTypes = prevVars;
}

function emitFuncLit(ctx: Ctx, f: ts.ArrowFunction | ts.FunctionExpression, want?: ts.TypeNode): string {
  const tps = emitTypeParams(ctx, "typeParameters" in f ? f.typeParameters : undefined);
  const params = emitParams(ctx, f.parameters);
  let ret = f.type ? emitType(ctx, f.type, true) : "";
  if (!ret && want && ts.isFunctionTypeNode(want)) ret = emitType(ctx, want.type, true);
  const prevRet = ctx.retType; ctx.retType = f.type ?? (want && ts.isFunctionTypeNode(want) ? want.type : undefined);
  const prevVars = ctx.varTypes; ctx.varTypes = new Map(prevVars);
  for (const p of f.parameters) if (ts.isIdentifier(p.name) && p.type) ctx.varTypes.set(p.name.text, emitType(ctx, p.type));
  ctx.inFunc++;
  let body: string;
  if (ts.isBlock(f.body)) {
    const inner = new W();
    emitParamDestructures(ctx, inner, f.parameters);
    for (const s of f.body.statements) { emitComments(ctx, inner, s); stmt(ctx, inner, s); }
    body = " {\n" + inner.text() + "\n" + "  ".repeat(0) + "}";
  } else {
    body = ` { return ${ex(ctx, f.body)} }`;
  }
  ctx.retType = prevRet; ctx.inFunc--; ctx.varTypes = prevVars;
  return `func${tps}(${params})${ret ? " " + ret : ""}${body}`;
}

function forInit(ctx: Ctx, init: ts.ForInitializer): string {
  if (ts.isVariableDeclarationList(init)) {
    const parts = init.declarations.map(d => {
      if (!ts.isIdentifier(d.name)) { fail(ctx, d, "destructuring not supported"); return "_"; }
      const t = d.type ? emitType(ctx, d.type) : "";
      const i = d.initializer ? ex(ctx, d.initializer, d.type) : "";
      return t ? `var ${d.name.text} ${t}${i ? " = " + i : ""}` : `${d.name.text} := ${i}`;
    });
    return parts.join(", ");
  }
  return ex(ctx, init);
}

function bindingName(ctx: Ctx, init: ts.ForInitializer): string {
  if (ts.isVariableDeclarationList(init) && init.declarations.length) {
    const n = init.declarations[0].name;
    if (ts.isIdentifier(n)) return n.text;
  }
  fail(ctx, init, "expected an identifier binding");
  return "_";
}

function forOfBinding(ctx: Ctx, init: ts.ForInitializer): string {
  if (!ts.isVariableDeclarationList(init) || !init.declarations.length) {
    fail(ctx, init, "expected a declaration");
    return "_";
  }
  const n = init.declarations[0].name;
  if (ts.isIdentifier(n)) return `_, ${n.text}`;
  if (ts.isArrayBindingPattern(n)) {
    // for (const [k, v] of m)  ->  for k, v := range m
    return n.elements.map(e => ts.isBindingElement(e) && ts.isIdentifier(e.name) ? e.name.text : "_").join(", ");
  }
  fail(ctx, n, "unsupported for-of binding");
  return "_";
}

function emitExprStmt(ctx: Ctx, w: W, e: ts.Expression) {
  if (ts.isBinaryExpression(e)) {
    const k = e.operatorToken.kind;
    // a ??= b / a ||= b / a &&= b  ->  conditional assignment
    if (k === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        k === ts.SyntaxKind.BarBarEqualsToken || k === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
      const lv = ex(ctx, e.left), rv = ex(ctx, e.right);
      const cond = k === ts.SyntaxKind.QuestionQuestionEqualsToken ? `${lv} == nil`
        : k === ts.SyntaxKind.BarBarEqualsToken ? falsy(ctx, e.left)
        : truthy(ctx, e.left);
      w.open(`if ${cond}`);
      w.w(`${lv} = ${rv}`);
      w.close();
      return;
    }
    // obj.y = v / obj.y += v through a setter -> obj.SetY(v) / obj.SetY(obj.Y() + v)
    if ((k === ts.SyntaxKind.EqualsToken || k === ts.SyntaxKind.PlusEqualsToken ||
         k === ts.SyntaxKind.MinusEqualsToken || k === ts.SyntaxKind.AsteriskEqualsToken ||
         k === ts.SyntaxKind.SlashEqualsToken) && ts.isPropertyAccessExpression(e.left)) {
      const t = typeNameOf(ctx, e.left.expression);
      const prop = e.left.name.text;
      if (t && ctx.setterOf.get(baseType(t))?.has(prop)) {
        const recv = ex(ctx, e.left.expression), rv = ex(ctx, e.right);
        const rhs = k === ts.SyntaxKind.EqualsToken ? rv
          : `${recv}.${cap(prop)}() ${e.operatorToken.getText().slice(0, -1)} ${rv}`;
        w.w(`${recv}.Set${cap(prop)}(${rhs})`);
        return;
      }
    }
  }
  if (ts.isCallExpression(e)) {
    const callee = e.expression;
    // go(f, args...)  ->  go f(args...)
    if (ts.isIdentifier(callee) && callee.text === "go" && e.arguments.length >= 1) {
      const fn = ex(ctx, e.arguments[0]);
      const rest = e.arguments.slice(1).map(a => ex(ctx, a)).join(", ");
      w.w(`go ${fn}(${rest})`);
      return;
    }
    // send(ch, v)  ->  ch <- v
    if (ts.isIdentifier(callee) && callee.text === "send" && e.arguments.length === 2) {
      w.w(`${ex(ctx, e.arguments[0])} <- ${ex(ctx, e.arguments[1])}`);
      return;
    }
    // arr.push(v)  ->  arr = append(arr, v)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "push") {
      const recv = ex(ctx, callee.expression);
      const args = e.arguments.map(a => ex(ctx, a)).join(", ");
      w.w(`${recv} = append(${recv}${args ? ", " + args : ""})`);
      return;
    }
    // arr.forEach(fn)  ->  for _, v := range arr { fn(v) }   (inline if arrow)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "forEach" && e.arguments.length === 1) {
      emitForEach(ctx, w, callee.expression, e.arguments[0]);
      return;
    }
    // super(...) inside a constructor  ->  this.Base = NewBase(...)
    if (e.expression.kind === ts.SyntaxKind.SuperKeyword) {
      // handled inside emitClass via marker below; if we get here just emit call
      w.w(ex(ctx, e));
      return;
    }
  }
  w.w(ex(ctx, e));
}

function emitForEach(ctx: Ctx, w: W, recv: ts.Expression, cb: ts.Expression) {
  const arr = ex(ctx, recv);
  if ((ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters.length >= 1) {
    const p = cb.parameters[0];
    if (!ts.isIdentifier(p.name)) { fail(ctx, p, "destructuring not supported"); return; }
    w.open(`for _, ${p.name.text} := range ${arr}`);
    if (ts.isArrowFunction(cb) && !ts.isBlock(cb.body)) {
      emitExprStmt(ctx, w, cb.body);
    } else if (ts.isBlock(cb.body)) {
      for (const s of cb.body.statements) { emitComments(ctx, w, s); stmt(ctx, w, s); }
    }
    w.close();
    return;
  }
  w.open(`for _, __v := range ${arr}`);
  w.w(`${ex(ctx, cb)}(__v)`);
  w.close();
}

function emitSwitch(ctx: Ctx, w: W, n: ts.SwitchStatement) {
  w.open(`switch ${ex(ctx, n.expression)}`);
  const clauses = [...n.caseBlock.clauses];
  clauses.forEach((c, i) => {
    if (ts.isCaseClause(c)) w.w(`case ${ex(ctx, c.expression)}:`); else w.w("default:");
    w.depth++;
    const stmts = [...c.statements];
    let falls = false;
    if (stmts.length && ts.isBreakStatement(stmts[stmts.length - 1])) stmts.pop();
    else if (stmts.length && i < clauses.length - 1) falls = true;
    for (const s of stmts) { emitComments(ctx, w, s); stmt(ctx, w, s); }
    if (falls) w.w("fallthrough");
    w.depth--;
  });
  w.close();
}

function emitTry(ctx: Ctx, w: W, n: ts.TryStatement) {
  // Mapped to defer/recover — Go's structured panic handling.
  // If the try body contains no return/break/continue, wrap it in an IIFE so
  // execution resumes after the block (TS semantics). Otherwise defer must be
  // emitted inline, and on panic the rest of the function is skipped.
  const isolated = !containsFlowStmt(n.tryBlock) && !containsFlowStmt(n.catchClause?.block);
  if (isolated) w.open("func()");
  if (n.finallyBlock) {
    const fs = n.finallyBlock.statements;
    // finally { call() } -> defer call()  (the Go idiom, not a wrapped IIFE)
    if (fs.length === 1 && ts.isExpressionStatement(fs[0]) && ts.isCallExpression(fs[0].expression)) {
      w.w(`defer ${ex(ctx, fs[0].expression)}`);
    } else {
      w.open("defer func()");
      for (const s of fs) { emitComments(ctx, w, s); stmt(ctx, w, s); }
      w.depth--; w.w("}()");
    }
  }
  if (n.catchClause) {
    const param = n.catchClause.variableDeclaration?.name;
    const name = param && ts.isIdentifier(param) ? param.text : "e";
    w.open("defer func()");
    w.open(`if ${name} := recover(); ${name} != nil`);
    for (const s of n.catchClause.block.statements) { emitComments(ctx, w, s); stmt(ctx, w, s); }
    w.depth--; w.w("}");
    w.depth--; w.w("}()");
  }
  for (const s of n.tryBlock.statements) { emitComments(ctx, w, s); stmt(ctx, w, s); }
  if (isolated) { w.depth--; w.w("}()"); }
}

// True if the block contains control flow that must escape the surrounding
// function — return, or a labeled break/continue — meaning try/catch can't be
// wrapped in an IIFE. throw is excluded: it panics and is recovered inside.
function containsFlowStmt(block: ts.Block | undefined): boolean {
  if (!block) return false;
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    // nested function/class bodies have their own control-flow scope
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) ||
        ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n)) return;
    if (ts.isReturnStatement(n) ||
        ((ts.isBreakStatement(n) || ts.isContinueStatement(n)) && n.label)) {
      found = true;
      return;
    }
    n.forEachChild(visit);
  };
  block.forEachChild(visit);
  return found;
}

// ---------- imports ----------

// does the emitted Go code reference this import's local names?
function importUsed(i: { alias: string; path: string; names?: string[] }, body: string): boolean {
  const local = i.alias || i.path.split("/").pop() || "";
  if (!local) return true; // side-effect import -> `import _ "path"`… kept
  if (i.alias === ".") return (i.names ?? []).some(n => new RegExp(`\\b${n}\\b`).test(body));
  return new RegExp(`\\b${local}\\.`).test(body);
}

function collectImport(ctx: Ctx, st: ts.ImportDeclaration, imports: { alias: string; path: string; names?: string[] }[]) {
  const path = st.moduleSpecifier.getText().replace(/^['"]|['"]$/g, "");
  const clause = st.importClause;
  // In gots a default import IS the package: `import nest from "nestgo/nest"`
  // -> `import nest "nestgo/nest"`. Named bindings combine freely:
  // `import d, {a} from "p"` -> alias + named, `import d, * as ns` -> one alias.
  const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined;
  const ns = clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings : undefined;

  if (path.startsWith(".")) {
    // relative import — same dir = same Go package (strip entirely, recording
    // `import {X as Y}` aliases); a different dir is a cross-package import
    const targetDir = pathResolve(ctx.file, "..", path, "..");
    const targetPkg = targetDir === ctx.rootDir ? "main" : pathBasename(targetDir);
    if (targetPkg === ctx.pkg) {
      if (clause?.name)
        fail(ctx, st, `default import '${clause.name.text}' from a same-package file has no package to bind — use named imports`);
      if (ns)
        fail(ctx, st, `namespace imports from same-package files have no package to bind — import the names directly`);
      if (named)
        for (const el of named)
          ctx.aliasOf.set(el.name.text, (el.propertyName ?? el.name).text);
      return;
    }
    const goPath = ctx.pkgPath.get(targetPkg) ?? targetPkg;
    if (clause?.name) {
      imports.push({ alias: clause.name.text, path: goPath });
      if (ns) ctx.aliasOf.set(ns.name.text, clause.name.text);
      if (named)
        for (const el of named)
          ctx.aliasOf.set(el.name.text, `${clause.name.text}.${(el.propertyName ?? el.name).text}`);
      return;
    }
    if (ns) { imports.push({ alias: ns.name.text, path: goPath }); return; }
    imports.push({ alias: "", path: goPath });
    if (named)
      for (const el of named)
        ctx.aliasOf.set(el.name.text, targetPkg + "." + (el.propertyName ?? el.name).text);
    return;
  }

  if (path === "nestgo/nest") {
    const nestName = ns ? ns.name.text : clause?.name?.text;
    if (nestName) ctx.nestAlias = nestName;
  }
  if (!clause) { imports.push({ alias: "", path }); return; }
  if (clause.name) imports.push({ alias: clause.name.text, path });
  if (named) {
    // import { Println } from "fmt"  ->  import . "fmt"
    imports.push({ alias: ".", path, names: named.map(e => e.name.text) });
  }
  if (ns) {
    if (clause.name) ctx.aliasOf.set(ns.name.text, clause.name.text); // d, * as ns — same package
    else imports.push({ alias: ns.name.text, path });
  }
  if (!clause.name && !clause.namedBindings) imports.push({ alias: "", path });
}

// ---------- classes / interfaces / enums ----------

// resolves the local alias for the nestgo/nest package — auto-imports it
// when decorator-driven codegen needs it but the source never imported it
function nestRef(ctx: Ctx): string {
  if (ctx.nestAlias) return ctx.nestAlias;
  ctx.uses.add("nestgo/nest");
  return "nest";
}

function emitClass(ctx: Ctx, w: W, d: ts.ClassDeclaration) {
  const name = d.name?.text ?? "Anon";
  // @Module classes are pure compile-time config — emit NewX() *nest.Module
  const modMeta = ctx.modules.get(name);
  if (modMeta) { emitModuleFactory(ctx, w, name, modMeta, nestRef(ctx)); return; }
  const info = ctx.classes.get(name);
  const fields: ts.PropertyDeclaration[] = [];
  const staticFields: ts.PropertyDeclaration[] = [];
  const methods: ts.MethodDeclaration[] = [];
  const staticMethods: ts.MethodDeclaration[] = [];
  const getters: ts.GetAccessorDeclaration[] = [];
  const setters: ts.SetAccessorDeclaration[] = [];
  let ctor: ts.ConstructorDeclaration | undefined;
  const paramProps: { name: string; type: string }[] = [];

  for (const m of d.members) {
    if (ts.isPropertyDeclaration(m)) {
      if (ts.isPrivateIdentifier(m.name)) { fail(ctx, m, "#private fields are not supported — use the 'private' keyword"); continue; }
      if (hasMod(m, ts.SyntaxKind.AccessorKeyword)) { fail(ctx, m, "auto-accessors are not supported — write explicit get/set"); continue; }
      (hasMod(m, ts.SyntaxKind.StaticKeyword) ? staticFields : fields).push(m);
    }
    else if (ts.isClassStaticBlockDeclaration(m)) fail(ctx, m, "static blocks are not supported — initialize in a package-level var or init()");
    else if (ts.isMethodDeclaration(m) && !m.body) fail(ctx, m, "method overloads are not supported — Go has one signature per method");
    else if (ts.isMethodDeclaration(m) && m.asteriskToken) fail(ctx, m, "generator methods are not supported");
    else if (ts.isMethodDeclaration(m)) (hasMod(m, ts.SyntaxKind.StaticKeyword) ? staticMethods : methods).push(m);
    else if (ts.isConstructorDeclaration(m)) {
      ctor = m;
      for (const p of m.parameters) {
        if (ts.isIdentifier(p.name) && (ts.canHaveModifiers(p) && (ts.getModifiers(p) ?? []).length > 0)) {
          paramProps.push({ name: p.name.text, type: emitType(ctx, p.type) });
        }
      }
    }
    else if (ts.isGetAccessorDeclaration(m)) {
      if (hasMod(m, ts.SyntaxKind.StaticKeyword)) fail(ctx, m, "static accessors are not supported");
      else getters.push(m);
    }
    else if (ts.isSetAccessorDeclaration(m)) {
      if (hasMod(m, ts.SyntaxKind.StaticKeyword)) fail(ctx, m, "static accessors are not supported");
      else setters.push(m);
    }
    else if (ts.isIndexSignatureDeclaration(m)) fail(ctx, m, "index signatures are not supported");
  }

  // struct — members are exported (capitalized) like TS's public default,
  // with json tags preserving the original key names.
  w.open(`type ${name} struct`);
  if (info?.embeds) w.w("*" + info.embeds);
  for (const f of fields) {
    const fname = f.name.getText();
    let t = f.type ? emitType(ctx, f.type) : (f.initializer ? inferType(ctx, f.initializer) : "any");
    if (f.questionToken && !isNilableGo(t)) t = "*" + t; // x?: T -> *T
    w.w(`${cap(fname)} ${t} \`json:"${fname}"\``);
  }
  for (const pp of paramProps) if (!fields.some(f => f.name.getText() === pp.name)) w.w(`${cap(pp.name)} ${pp.type} \`json:"${pp.name}"\``);
  w.close();
  w.w("");

  // static fields -> package vars
  for (const f of staticFields) {
    const fname = f.name.getText();
    const t = f.type ? emitType(ctx, f.type) : "any";
    w.w(`var ${name}_${fname} ${t}${f.initializer ? " = " + ex(ctx, f.initializer) : ""}`);
  }
  if (staticFields.length) w.w("");

  // constructor -> NewX; injectable/controller classes always get NewX —
  // the DI container resolves providers by their constructor func.
  const prevThis = ctx.thisType; ctx.thisType = name;
  const injectable = ctx.injectables.has(name) || ctx.ctrls.has(name);
  if (ctor || injectable) {
    w.open(`func New${name}(${ctor ? emitParams(ctx, ctor.parameters) : ""}) *${name}`);
    w.w(`this := &${name}{}`);
    if (info?.embeds) {
      const baseInfo = ctx.classes.get(info.embeds);
      w.w(`this.${info.embeds} = ${baseInfo?.hasCtor ? `New${info.embeds}()` : `&${info.embeds}{}`}`);
    }
    for (const f of fields) if (f.initializer) w.w(`this.${cap(f.name.getText())} = ${ex(ctx, f.initializer, f.type)}`);
    for (const pp of paramProps) w.w(`this.${cap(pp.name)} = ${pp.name}`);
    ctx.inFunc++;
    if (ctor) emitParamDestructures(ctx, w, ctor.parameters);
    if (ctor?.body) for (const s of ctor.body.statements) emitCtorStmt(ctx, w, s, info?.embeds);
    ctx.inFunc--;
    w.w("return this");
    w.close();
    w.w("");
  }

  // methods
  for (const m of methods) {
    if (!m.name) continue;
    const mname = cap(m.name.getText());
    const tps = emitTypeParams(ctx, m.typeParameters);
    const ret = emitType(ctx, m.type, true);
    const prevRet = ctx.retType; ctx.retType = m.type; ctx.inFunc++;
    const prevVars = ctx.varTypes; ctx.varTypes = new Map(prevVars);
    for (const p of m.parameters) if (ts.isIdentifier(p.name) && p.type) ctx.varTypes.set(p.name.text, emitType(ctx, p.type));
    w.open(`func (this *${name}) ${mname}${tps}(${emitParams(ctx, m.parameters)})${ret ? " " + ret : ""}`);
    emitParamDestructures(ctx, w, m.parameters);
    if (m.body) for (const s of m.body.statements) { emitComments(ctx, w, s); stmt(ctx, w, s); }
    w.close();
    w.w("");
    ctx.retType = prevRet; ctx.inFunc--; ctx.varTypes = prevVars;
  }

  // accessors -> methods: get y(): T => Y() T;  set y(v: T) => SetY(v T)
  for (const g of getters) {
    const ret = emitType(ctx, g.type, true);
    const prevRet = ctx.retType; ctx.retType = g.type; ctx.inFunc++;
    const prevVars = ctx.varTypes; ctx.varTypes = new Map(prevVars);
    w.open(`func (this *${name}) ${cap(g.name.getText())}()${ret ? " " + ret : ""}`);
    if (g.body) for (const s of g.body.statements) { emitComments(ctx, w, s); stmt(ctx, w, s); }
    w.close();
    w.w("");
    ctx.retType = prevRet; ctx.inFunc--; ctx.varTypes = prevVars;
  }
  for (const s of setters) {
    const prevVars = ctx.varTypes; ctx.varTypes = new Map(prevVars);
    for (const p of s.parameters) if (ts.isIdentifier(p.name) && p.type) ctx.varTypes.set(p.name.text, emitType(ctx, p.type));
    const prevRet = ctx.retType; ctx.retType = undefined; ctx.inFunc++;
    w.open(`func (this *${name}) Set${cap(s.name.getText())}(${emitParams(ctx, s.parameters)})`);
    if (s.body) for (const st of s.body.statements) { emitComments(ctx, w, st); stmt(ctx, w, st); }
    w.close();
    w.w("");
    ctx.retType = prevRet; ctx.inFunc--; ctx.varTypes = prevVars;
  }

  // static methods -> package funcs named X_m
  for (const m of staticMethods) {
    if (!m.name) continue;
    const mname = m.name.getText();
    const ret = emitType(ctx, m.type, true);
    const prevRet = ctx.retType; ctx.retType = m.type; ctx.inFunc++;
    const prevVars = ctx.varTypes; ctx.varTypes = new Map(prevVars);
    for (const p of m.parameters) if (ts.isIdentifier(p.name) && p.type) ctx.varTypes.set(p.name.text, emitType(ctx, p.type));
    w.open(`func ${name}_${mname}(${emitParams(ctx, m.parameters)})${ret ? " " + ret : ""}`);
    emitParamDestructures(ctx, w, m.parameters);
    if (m.body) for (const s of m.body.statements) { emitComments(ctx, w, s); stmt(ctx, w, s); }
    w.close();
    w.w("");
    ctx.retType = prevRet; ctx.inFunc--; ctx.varTypes = prevVars;
  }
  ctx.thisType = prevThis;
}

function emitCtorStmt(ctx: Ctx, w: W, s: ts.Statement, embeds?: string) {
  // super(args) -> this.Base = NewBase(args)
  if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) &&
      s.expression.expression.kind === ts.SyntaxKind.SuperKeyword) {
    const args = s.expression.arguments.map(a => ex(ctx, a)).join(", ");
    if (embeds) w.w(`this.${embeds} = New${embeds}(${args})`);
    else fail(ctx, s, "super() call but class has no extends clause");
    return;
  }
  emitComments(ctx, w, s);
  stmt(ctx, w, s);
}

function emitInterface(ctx: Ctx, w: W, d: ts.InterfaceDeclaration) {
  // pure index signatures -> a Go map type: { [k: string]: V } -> map[string]V
  if (d.members.length && d.members.every(m => ts.isIndexSignatureDeclaration(m))) {
    const m = d.members[0] as ts.IndexSignatureDeclaration;
    const kt = m.parameters[0]?.type ? emitType(ctx, m.parameters[0].type) : "string";
    const vt = m.type ? emitType(ctx, m.type) : "any";
    w.w(`type ${d.name.text} map[${kt}]${vt}`);
    w.w("");
    return;
  }
  const methods = d.members.filter(ts.isMethodSignature);
  const props = d.members.filter(ts.isPropertySignature);
  const others = d.members.length - methods.length - props.length;
  if (others > 0 || (methods.length && props.length)) {
    fail(ctx, d, "interfaces must be all-method (Go interface) or all-field (Go struct)");
    return;
  }
  const tps = emitTypeParams(ctx, d.typeParameters);
  if (methods.length || d.members.length === 0) {
    if (tps) fail(ctx, d, "generic interfaces are not supported");
    w.open(`type ${d.name.text} interface`);
    for (const m of methods) {
      const ret = emitType(ctx, m.type, true);
      w.w(`${cap(m.name.getText())}(${emitParams(ctx, m.parameters)})${ret ? " " + ret : ""}`);
    }
    w.close();
  } else {
    w.open(`type ${d.name.text}${tps} struct`);
    for (const p of props) {
      const t = p.questionToken ? "*" + emitType(ctx, p.type) : emitType(ctx, p.type);
      const pname = p.name.getText();
      w.w(`${cap(pname)} ${t} \`json:"${pname}"\``);
    }
    w.close();
  }
  w.w("");
}

function emitEnum(ctx: Ctx, w: W, d: ts.EnumDeclaration) {
  const members = [...d.members];
  const firstInit = members.find(m => m.initializer)?.initializer;
  const isString = firstInit && ts.isStringLiteral(firstInit);
  const goType = isString ? "string" : "int";
  w.w(`type ${d.name.text} ${goType}`);
  w.w("const (");
  w.depth++;
  let counter = 0;
  for (const m of members) {
    const mname = m.name.getText();
    if (m.initializer) {
      if (ts.isNumericLiteral(m.initializer)) { counter = parseInt(m.initializer.text, 10) + 1; }
      w.w(`${mname} ${d.name.text} = ${ex(ctx, m.initializer)}`);
    } else {
      w.w(`${mname} ${d.name.text} = ${counter++}`);
    }
  }
  w.depth--;
  w.w(")");
  w.w("");
}

// ---------- expressions ----------

function ex(ctx: Ctx, e: ts.Expression, want?: ts.TypeNode): string {
  switch (e.kind) {
    case ts.SyntaxKind.NumericLiteral: return e.getText();
    case ts.SyntaxKind.BigIntLiteral: return e.getText().replace(/n$/, "");
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral: {
      const s = (e as ts.StringLiteral).text;
      if (e.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral && !s.includes("`") && !s.includes("\\")) return "`" + s + "`";
      return JSON.stringify(s);
    }
    case ts.SyntaxKind.TrueKeyword: return "true";
    case ts.SyntaxKind.FalseKeyword: return "false";
    case ts.SyntaxKind.NullKeyword: return "nil";
    case ts.SyntaxKind.ThisKeyword: return "this";
    case ts.SyntaxKind.SuperKeyword: return "this";
    case ts.SyntaxKind.Identifier: {
      const id = (e as ts.Identifier).text;
      if (id === "undefined") return "nil";
      if (id === "arguments") { fail(ctx, e, "'arguments' is not supported — use rest params (...args)"); return "nil"; }
      // a @Module class used as a value -> its module factory call
      if (ctx.modules.has(id)) return `${qNew(ctx, id)}()`;
      if (ctx.aliasOf.has(id)) return ctx.aliasOf.get(id)!;
      return id;
    }
    case ts.SyntaxKind.ParenthesizedExpression:
      return `(${ex(ctx, (e as ts.ParenthesizedExpression).expression, want)})`;
    case ts.SyntaxKind.TemplateExpression: {
      const t = e as ts.TemplateExpression;
      const parts: string[] = [t.head.text];
      const args: string[] = [];
      for (const span of t.templateSpans) {
        parts.push("%v", span.literal.text);
        args.push(ex(ctx, span.expression));
      }
      ctx.uses.add("fmt");
      return `fmt.Sprintf(${JSON.stringify(parts.join(""))}${args.length ? ", " + args.join(", ") : ""})`;
    }
    case ts.SyntaxKind.PrefixUnaryExpression: {
      const p = e as ts.PrefixUnaryExpression;
      if (p.operator === ts.SyntaxKind.PlusPlusToken) return `++${ex(ctx, p.operand)}`;
      if (p.operator === ts.SyntaxKind.MinusMinusToken) return `--${ex(ctx, p.operand)}`;
      if (p.operator === ts.SyntaxKind.ExclamationToken) return `!${ex(ctx, p.operand)}`;
      if (p.operator === ts.SyntaxKind.MinusToken) return `-${ex(ctx, p.operand)}`;
      if (p.operator === ts.SyntaxKind.PlusToken) return `+${ex(ctx, p.operand)}`;
      if (p.operator === ts.SyntaxKind.TildeToken) return `^${ex(ctx, p.operand)}`;
      fail(ctx, e, "unsupported prefix operator");
      return ex(ctx, p.operand);
    }
    case ts.SyntaxKind.PostfixUnaryExpression: {
      const p = e as ts.PostfixUnaryExpression;
      return `${ex(ctx, p.operand)}${p.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--"}`;
    }
    case ts.SyntaxKind.TypeOfExpression: {
      // typeof x — statically known types fold to JS literals; `any` -> %T
      const to = e as ts.TypeOfExpression;
      const lt = rawGoType(ctx, to.expression);
      if (lt === "bool") return `"boolean"`;
      if (lt === "string") return `"string"`;
      if (lt && NUMERIC_RE.test(lt)) return `"number"`;
      if (lt && lt.startsWith("func(")) return `"function"`;
      if (lt && !isNilableGo(lt)) return `"object"`;
      ctx.uses.add("fmt");
      return `fmt.Sprintf("%T", ${ex(ctx, to.expression)})`;
    }
    case ts.SyntaxKind.BinaryExpression: return binary(ctx, e as ts.BinaryExpression, want);
    case ts.SyntaxKind.PropertyAccessExpression: return propAccess(ctx, e as ts.PropertyAccessExpression, want);
    case ts.SyntaxKind.ElementAccessExpression: {
      const ea = e as ts.ElementAccessExpression;
      if (ea.questionDotToken)
        return optChain(ctx, ea.expression, r => `${r}[${ex(ctx, ea.argumentExpression)}]`, want, e);
      return `${ex(ctx, ea.expression)}[${ex(ctx, ea.argumentExpression)}]`;
    }
    case ts.SyntaxKind.CallExpression: return call(ctx, e as ts.CallExpression, want);
    case ts.SyntaxKind.NewExpression: {
      const n = e as ts.NewExpression;
      const name = n.expression.getText();
      const args = (n.arguments ?? []).map(a => ex(ctx, a)).join(", ");
      const tas = n.typeArguments ?? [];
      // Go built-in composites in constructor form:
      //   new Channel<int>(4) -> make(chan int, 4)
      //   new Map<string,int>() -> make(map[string]int)
      //   new Array<int>(8) -> make([]int, 8)
      if (name === "Channel" && tas.length === 1)
        return `make(chan ${emitType(ctx, tas[0])}${args ? ", " + args : ""})`;
      if (name === "Map" && tas.length === 2)
        return `make(map[${emitType(ctx, tas[0])}]${emitType(ctx, tas[1])}${args ? ", " + args : ""})`;
      if (name === "Array" && tas.length === 1)
        return `make([]${emitType(ctx, tas[0])}, ${args || "0"})`;
      if (name === "Error") { ctx.uses.add("errors"); return `errors.New(${args})`; }
      if (name === "Channel" || name === "Map" || name === "Array") {
        fail(ctx, n, `new ${name}<T>(...) needs its type arguments — e.g. new ${name}<string, int>()`);
        return "nil";
      }
      if (ctx.modules.has(name)) return `${qNew(ctx, name)}()`; // `new AppModule()` — module factory
      const info = ctx.classes.get(name);
      if (info?.hasCtor) return `${qNew(ctx, name)}(${args})`;
      return `&${qname(ctx, name)}{${args}}`;
    }
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.FunctionExpression:
      return emitFuncLit(ctx, e as ts.ArrowFunction, want);
    case ts.SyntaxKind.AsExpression:
    case ts.SyntaxKind.TypeAssertionExpression: {
      const a = e as ts.AsExpression;
      if (ts.isTypeReferenceNode(a.type) && a.type.typeName.getText() === "const") {
        fail(ctx, e, "'as const' is not supported — declare a const or a literal type");
        return ex(ctx, a.expression);
      }
      return `${emitType(ctx, a.type)}(${ex(ctx, a.expression)})`; // x as T -> T(x)
    }
    case ts.SyntaxKind.SatisfiesExpression:
      return ex(ctx, (e as ts.SatisfiesExpression).expression, want);
    case ts.SyntaxKind.NonNullExpression:
      return ex(ctx, (e as ts.NonNullExpression).expression, want);
    case ts.SyntaxKind.ObjectLiteralExpression: return objectLit(ctx, e as ts.ObjectLiteralExpression, want);
    case ts.SyntaxKind.ArrayLiteralExpression: {
      const a = e as ts.ArrayLiteralExpression;
      const elem = want && ts.isArrayTypeNode(want) ? want.elementType
        : want && ts.isTypeReferenceNode(want) && want.typeName.getText() === "Array" ? want.typeArguments?.[0]
        : undefined;
      const goT = `[]${elem ? emitType(ctx, elem) : a.elements.length ? inferType(ctx, a.elements[0]) : "any"}`;
      // spread elements can't live inside a composite literal — append chain:
      // [...a, x, ...b] -> append(append(append([]T{}, a...), x), b...)
      if (a.elements.some(el => ts.isSpreadElement(el))) {
        const firstVal = a.elements.find(el => !ts.isSpreadElement(el));
        const st = `[]${elem ? emitType(ctx, elem) : firstVal ? inferType(ctx, firstVal) : "any"}`;
        let out = `${st}{}`;
        let pending: string[] = [];
        const flush = () => {
          if (!pending.length) return;
          out = out === `${st}{}` ? `${st}{${pending.join(", ")}}` : `append(${out}, ${pending.join(", ")})`;
          pending = [];
        };
        for (const el of a.elements) {
          if (ts.isSpreadElement(el)) {
            flush();
            out = `append(${out}, ${ex(ctx, el.expression)}...)`;
          } else {
            pending.push(ex(ctx, el));
          }
        }
        flush();
        return out;
      }
      return `${goT}{${a.elements.map(el => ex(ctx, el)).join(", ")}}`;
    }
    case ts.SyntaxKind.ConditionalExpression: {
      const c = e as ts.ConditionalExpression;
      if (!want) { fail(ctx, e, "ternary needs a declared type (annotate the variable/return type)"); return "nil"; }
      const t = emitType(ctx, want);
      return `(func() ${t} {\nif ${ex(ctx, c.condition)} {\nreturn ${ex(ctx, c.whenTrue, want)}\n}\nreturn ${ex(ctx, c.whenFalse, want)}\n})()`;
    }
    case ts.SyntaxKind.AwaitExpression:
      return ex(ctx, (e as ts.AwaitExpression).expression, want); // Go calls are synchronous
    case ts.SyntaxKind.DeleteExpression: {
      const d = (e as ts.DeleteExpression).expression;
      if (ts.isElementAccessExpression(d)) return `delete(${ex(ctx, d.expression)}, ${ex(ctx, d.argumentExpression)})`;
      fail(ctx, e, "delete only supports element access: delete m[k]");
      return "nil";
    }
    case ts.SyntaxKind.VoidExpression: return "nil";
    case ts.SyntaxKind.SpreadElement: {
      fail(ctx, e, "spread in this position is not supported");
      return "";
    }
    case ts.SyntaxKind.RegularExpressionLiteral:
      fail(ctx, e, "regex literals are not supported — use the regexp package");
      return `""`;
    case ts.SyntaxKind.MetaProperty:
      fail(ctx, e, "meta properties (new.target/import.meta) are not supported");
      return "nil";
    default:
      fail(ctx, e, `unsupported expression: ${ts.SyntaxKind[e.kind]}`);
      return "nil";
  }
}

function isConstExpr(ctx: Ctx, e: ts.Expression): boolean {
  if (ts.isLiteralExpression(e) || ts.isNoSubstitutionTemplateLiteral(e) ||
      e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isParenthesizedExpression(e)) return isConstExpr(ctx, e.expression);
  if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return isConstExpr(ctx, e.expression);
  if (ts.isBinaryExpression(e)) {
    const k = e.operatorToken.kind;
    // ?? always emits an IIFE; ||/&& only stay const on bool operands —
    // non-bool operands become zero-value IIFEs, which consts can't hold
    if (k === ts.SyntaxKind.QuestionQuestionToken) return false;
    if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.AmpersandAmpersandToken) {
      const t = tsRealType(ctx, e.left);
      const boolish = t != null && (t.flags & ts.TypeFlags.BooleanLike) !== 0;
      if (!boolish) return false;
    }
    return isConstExpr(ctx, e.left) && isConstExpr(ctx, e.right);
  }
  if (ts.isPrefixUnaryExpression(e)) return isConstExpr(ctx, e.operand);
  if (ts.isIdentifier(e)) return ctx.consts.has(e.text);
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && ctx.enums.has(e.expression.text)) return true;
  return false;
}

function inferType(ctx: Ctx, e: ts.Expression): string {
  const local = inferTypeLocal(ctx, e);
  return local !== "any" ? local : checkedGoType(ctx, e) ?? "any";
}

function inferTypeLocal(ctx: Ctx, e: ts.Expression): string {
  if (ts.isNumericLiteral(e)) return e.getText().includes(".") ? "float64" : "int";
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) return "string";
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return "bool";
  if (ts.isArrayLiteralExpression(e)) return "[]" + (e.elements.length ? inferType(ctx, e.elements[0]) : "any");
  if (ts.isNewExpression(e)) {
    const nname = e.expression.getText();
    const ntas = e.typeArguments ?? [];
    if (nname === "Channel" && ntas.length) return "chan " + emitType(ctx, ntas[0]);
    if (nname === "Map" && ntas.length === 2) return `map[${emitType(ctx, ntas[0])}]${emitType(ctx, ntas[1])}`;
    if (nname === "Array" && ntas.length) return "[]" + emitType(ctx, ntas[0]);
    return "*" + nname;
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    const fn = e.expression.text;
    const tas = e.typeArguments;
    if (fn === "newChan" && tas?.length) return "chan " + emitType(ctx, tas[0]);
    if (fn === "newSlice" && tas?.length) return "[]" + emitType(ctx, tas[0]);
    if (fn === "newMap" && tas?.length === 2) return `map[${emitType(ctx, tas[0])}]${emitType(ctx, tas[1])}`;
    if (fn in GO_TYPE_ALIASES) return GO_TYPE_ALIASES[fn]; // Int32(3) -> int32
    return ctx.funcRets.get(fn) ?? "any";
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const recv = typeNameOf(ctx, e.expression.expression);
    if (recv) return ctx.methodRets.get(baseType(recv))?.get(e.expression.name.text) ?? "any";
  }
  return "any";
}

function binary(ctx: Ctx, b: ts.BinaryExpression, want?: ts.TypeNode): string {
  const op = b.operatorToken.kind;
  const l = () => ex(ctx, b.left), r = () => ex(ctx, b.right);
  const isBoolOperand = (e: ts.Expression): boolean => {
    if (rawGoType(ctx, e) === "bool") return true;
    const t = tsRealType(ctx, e);
    return t != null && (t.flags & ts.TypeFlags.BooleanLike) !== 0;
  };
  switch (op) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken: return `${l()} == ${r()}`;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken: return `${l()} != ${r()}`;
    case ts.SyntaxKind.AsteriskAsteriskToken: ctx.uses.add("math"); return `math.Pow(${l()}, ${r()})`;
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken: ctx.uses.add("math"); return `${l()} = math.Pow(${l()}, ${r()})`;
    case ts.SyntaxKind.InstanceOfKeyword: {
      // x instanceof C -> type assert; class instances are *C in Go.
      // A statically non-nilable LHS (int, string, struct) can never match.
      const tn = b.right.getText();
      const lt = rawGoType(ctx, b.left);
      if (lt && lt !== "any" && !isNilableGo(lt)) return "false";
      const t = tn === "Error" ? "error" : ctx.classes.has(tn) ? "*" + qname(ctx, tn) : qname(ctx, tn);
      return `(func() bool {\n_, ok := ${l()}.(${t})\nreturn ok\n})()`;
    }
    case ts.SyntaxKind.InKeyword: {
      // k in m -> ok-form map lookup; i in slice -> bounds check
      const rt0 = rawGoType(ctx, b.right) ?? "";
      if (rt0.startsWith("[]")) {
        const i = `__i${ctx.tmpN++}`;
        return `(func() bool {\n${i} := ${l()}\nreturn ${i} >= 0 && ${i} < len(${r()})\n})()`;
      }
      return `(func() bool {\n_, ok := ${r()}[${l()}]\nreturn ok\n})()`;
    }
    case ts.SyntaxKind.QuestionQuestionToken: {
      // a?.b ?? c — fuse into one nil-check so the zero value doesn't swallow c
      const qd = qdLeft(ctx, b.left);
      if (qd) {
        const rlt = rawGoType(ctx, qd.recv);
        if (!rlt || isNilableGo(rlt)) {
          const rt = want ? emitType(ctx, want) : checkedGoType(ctx, b.left) ?? "any";
          return `(func() ${rt} {\n__q := ${ex(ctx, qd.recv)}\nif __q == nil {\nreturn ${r()}\n}\nreturn ${qd.tail("__q")}\n})()`;
        }
      }
      // a ?? b -> nil-guarded IIFE; non-nilable LHS collapses to just `a`
      const lt = rawGoType(ctx, b.left);
      const rt = want ? emitType(ctx, want) : lt ?? "any";
      if (lt && !isNilableGo(lt)) return l();
      const re = r();
      // `a ?? plainValue` where the target is *T — take the value's address
      const bt = rawGoType(ctx, b.right);
      const reFix = rt.startsWith("*") && bt && !isNilableGo(bt) && baseType(bt) === baseType(rt.slice(1)) ? `&${re}` : re;
      return `(func() ${rt} {\nif ${l()} != nil {\nreturn ${l()}\n}\nreturn ${reFix}\n})()`;
    }
    case ts.SyntaxKind.BarBarToken: {
      if (isBoolOperand(b.left)) return `${l()} || ${r()}`;
      // JS truthiness: falsy LHS yields RHS — map to Go zero values
      const rt = want ? emitType(ctx, want) : rawGoType(ctx, b.left) ?? rawGoType(ctx, b.right) ?? "any";
      return `(func() ${rt} {\nif ${truthy(ctx, b.left)} {\nreturn ${l()}\n}\nreturn ${r()}\n})()`;
    }
    case ts.SyntaxKind.AmpersandAmpersandToken: {
      if (isBoolOperand(b.left)) return `${l()} && ${r()}`;
      const rt = want ? emitType(ctx, want) : rawGoType(ctx, b.left) ?? "any";
      return `(func() ${rt} {\nif ${truthy(ctx, b.left)} {\nreturn ${r()}\n}\nreturn ${l()}\n})()`;
    }
    case ts.SyntaxKind.QuestionQuestionEqualsToken:
    case ts.SyntaxKind.BarBarEqualsToken:
    case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
      fail(ctx, b, "'??='/'||='/'&&=' are only supported as statements"); return l();
    case ts.SyntaxKind.CommaToken: fail(ctx, b, "comma expressions are not supported"); return r();
    default: {
      const tok = b.operatorToken.getText();
      return `${l()} ${tok} ${r()}`;
    }
  }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// Resolve the Go type name an expression evaluates to (best effort —
// tracks annotated vars, params, this, new/call expressions).
// Resolve a TS type to gots' Go-type vocabulary via the real checker.
// Brands survive as `number & { __gots: "int32" }` — the literal value IS
// the Go type name, so nominal typing round-trips through the checker.
function goTypeName(ctx: Ctx, ch: ts.TypeChecker, t: ts.Type, at: ts.Expression): string | undefined {
  if (t.isUnion()) {
    const real = t.types.find(x =>
      !(x.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
    if (real) return goTypeName(ctx, ch, real, at);
  }
  const brand = t.getProperty("__gots");
  if (brand) {
    const bt = ch.getTypeOfSymbolAtLocation(brand, at);
    if (bt.isStringLiteral()) return bt.value;
  }
  const sym = t.getSymbol() ?? t.aliasSymbol;
  const name = sym?.getName();
  if (name === "Channel") {
    const el = ch.getTypeArguments(t as ts.TypeReference)[0];
    return `chan ${el ? goTypeName(ctx, ch, el, at) ?? "any" : "any"}`;
  }
  if (name === "Map") {
    const [k, v] = ch.getTypeArguments(t as ts.TypeReference);
    return `map[${k ? goTypeName(ctx, ch, k, at) ?? "string" : "string"}]${v ? goTypeName(ctx, ch, v, at) ?? "any" : "any"}`;
  }
  if (ch.isArrayType(t)) {
    const el = ch.getTypeArguments(t as ts.TypeReference)[0];
    return `[]${el ? goTypeName(ctx, ch, el, at) ?? "any" : "any"}`;
  }
  if (name === "Error" || name === "error") return "error";
  if (name) {
    const decl = sym!.getDeclarations()?.[0];
    if (decl && ts.isClassDeclaration(decl)) return "*" + name;
    if (decl && ts.isInterfaceDeclaration(decl)) return name;
    if (decl && ts.isEnumDeclaration(decl)) return name;
    return undefined; // module namespaces, lib globals — not our domain
  }
  if (t.flags & ts.TypeFlags.StringLike) return "string";
  if (t.flags & ts.TypeFlags.BooleanLike) return "bool";
  if (t.flags & ts.TypeFlags.EnumLiteral) return ch.typeToString(t).split(".")[0];
  // unbranded `number` is ambiguous (int? float?) — leave it to local inference
  if (t.flags & ts.TypeFlags.AnyLike) return "any";
  return undefined;
}

function checkedGoType(ctx: Ctx, e: ts.Expression): string | undefined {
  if (!ctx.checker) return undefined;
  try {
    return goTypeName(ctx, ctx.checker, ctx.checker.getTypeAtLocation(e), e);
  } catch {
    return undefined;
  }
}

function typeNameOf(ctx: Ctx, e: ts.Expression): string | undefined {
  let t: string | undefined;
  if (ts.isIdentifier(e)) t = ctx.varTypes.get(e.text);
  else if (e.kind === ts.SyntaxKind.ThisKeyword) t = ctx.thisType;
  else if (ts.isNewExpression(e)) t = "*" + e.expression.getText();
  else if (ts.isElementAccessExpression(e)) t = typeNameOf(ctx, e.expression);
  else if (ts.isParenthesizedExpression(e)) t = typeNameOf(ctx, e.expression);
  else if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) t = ctx.funcRets.get(e.expression.text);
  else if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const recv = typeNameOf(ctx, e.expression.expression);
    if (recv) t = ctx.methodRets.get(baseType(recv))?.get(e.expression.name.text);
  }
  if (!t) t = checkedGoType(ctx, e); // real checker covers what scope tables miss
  if (!t) return undefined;
  if (t.startsWith("[]")) t = t.slice(2);
  if (t.startsWith("*")) t = t.slice(1);
  return t;
}

// member name on a known type -> exported (capitalized) Go name
function memberName(ctx: Ctx, recv: ts.Expression, prop: string): string {
  const t = typeNameOf(ctx, recv);
  if (t && ctx.memberOf.get(baseType(t))?.has(prop)) return cap(prop);
  return prop;
}

function propAccess(ctx: Ctx, p: ts.PropertyAccessExpression, want?: ts.TypeNode): string {
  const prop = p.name.text;
  // a?.b — nil-guarded access (a?.length keeps len() inside the guard)
  if (p.questionDotToken) {
    if (prop === "length") return optChain(ctx, p.expression, r => `len(${r})`, want, p);
    return optChain(ctx, p.expression, r => `${r}.${memberName(ctx, p.expression, prop)}`, want, p);
  }
  if (prop === "length") return `len(${ex(ctx, p.expression)})`;
  // Class.prototype.method -> (*Class).Method — Go's method-expression form,
  // used when registering handlers by type rather than instance
  if (ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === "prototype" &&
      ts.isIdentifier(p.expression.expression) && ctx.classes.has(p.expression.expression.text))
    return `(*${pkgPrefixOf(ctx, p.expression.expression.text)}${p.expression.expression.text}).${cap(prop)}`;
  if (prop === "prototype" && ts.isIdentifier(p.expression) && ctx.classes.has(p.expression.text))
    return `(*${qname(ctx, p.expression.text)})`; // bare `X.prototype` -> (*X)
  // Enum.Member -> Member (Go enum members are package-level consts)
  if (ts.isIdentifier(p.expression) && ctx.enums.has(p.expression.text)) return pkgPrefixOf(ctx, p.expression.text) + prop;
  // Class.staticMember -> Class_member
  if (ts.isIdentifier(p.expression)) {
    const cls = ctx.classes.get(p.expression.text);
    if (cls?.statics.has(prop)) return `${pkgPrefixOf(ctx, p.expression.text)}${p.expression.text}_${prop}`;
    if (p.expression.text === "process" && prop === "argv") { ctx.uses.add("os"); return "os.Args"; }
    if (p.expression.text === "Math") { ctx.uses.add("math"); return "math." + prop[0].toUpperCase() + prop.slice(1); }
  }
  // getter access -> a.GetProp() — accessors emit as methods
  const rt = typeNameOf(ctx, p.expression);
  if (rt && ctx.getterOf.get(baseType(rt))?.has(prop))
    return `${ex(ctx, p.expression)}.${cap(prop)}()`;
  return `${ex(ctx, p.expression)}.${memberName(ctx, p.expression, prop)}`;
}

function call(ctx: Ctx, c: ts.CallExpression, want?: ts.TypeNode): string {
  const callee = c.expression;
  const typeArgs = c.typeArguments?.length ? `[${c.typeArguments.map(t => emitType(ctx, t, false, true)).join(", ")}]` : "";
  const args = (defs?: (ts.Expression | undefined)[]) =>
    padArgs(ctx, c, defs);

  // a?.f(x) — the ?. lives on the property access; a.f?.(x) on the call
  if (ts.isPropertyAccessExpression(callee) && callee.questionDotToken) {
    const obj = callee.expression, prop = callee.name.text;
    return optChain(ctx, obj, r =>
      `${r}.${memberName(ctx, obj, prop)}(${args(methodDefsOf(ctx, obj, prop))})`, want, c);
  }
  if (c.questionDotToken) {
    // callee itself may be nil: a?.(x) / a.f?.(x)
    const recv = ts.isPropertyAccessExpression(callee)
      ? ex(ctx, callee)
      : ts.isIdentifier(callee) ? callee.text : ex(ctx, callee);
    return `(func() ${want ? emitType(ctx, want) : "any"} {\nif ${recv} == nil {\nreturn nil\n}\nreturn ${recv}(${args()})\n})()`;
  }

  // builtins
  if (ts.isIdentifier(callee)) {
    const name = callee.text;
    if (name === "eval" || name === "Function") { fail(ctx, c, `'${name}' is not supported`); return "nil"; }
    if (GO_BUILTINS.has(name)) return `${name}(${args()})`;
    if (GO_TYPES.has(name) && c.arguments.length === 1) return `${name}(${args()})`; // conversion
    if (name in GO_TYPE_ALIASES && c.arguments.length === 1)
      return `${GO_TYPE_ALIASES[name]}(${args()})`; // alias conversion: Float64(x) -> float64(x)
    if (name === "newSlice" && c.typeArguments?.length) {
      const t = emitType(ctx, c.typeArguments[0]);
      return `make([]${t}, ${c.arguments.length ? args() : "0"})`;
    }
    if (name === "newMap" && c.typeArguments?.length === 2) {
      return `make(map[${emitType(ctx, c.typeArguments[0])}]${emitType(ctx, c.typeArguments[1])})`;
    }
    if (name === "newChan" && c.typeArguments?.length) {
      return `make(chan ${emitType(ctx, c.typeArguments[0])}${c.arguments.length ? ", " + args() : ""})`;
    }
    if (name === "recv" && c.arguments.length === 1) return `<-${ex(ctx, c.arguments[0])}`;
    if (name === "parseInt" && c.arguments.length === 1) {
      ctx.uses.add("strconv");
      return `(func() int { n, _ := strconv.Atoi(${ex(ctx, c.arguments[0])}); return n }())`;
    }
    if (name === "parseFloat" && c.arguments.length === 1) {
      ctx.uses.add("strconv");
      return `(func() float64 { n, _ := strconv.ParseFloat(${ex(ctx, c.arguments[0])}, 64); return n }())`;
    }
    if (name === "go" || name === "send") {
      fail(ctx, c, `'${name}(...)' must be used as a statement, not inside an expression`);
      return "nil";
    }
    return `${name}${typeArgs}(${args(ctx.funcDefaults.get(name))})`;
  }

  if (ts.isPropertyAccessExpression(callee)) {
    const obj = callee.expression;
    const prop = callee.name.text;

    // console.* -> fmt.*
    if (ts.isIdentifier(obj) && obj.text === "console") {
      ctx.uses.add("fmt");
      // fmt.Println(...any) can't take []T spread — convert to []any first
      const anyArgs = () => c.arguments.map(a => ts.isSpreadElement(a)
        ? `(func() []any { __s := make([]any, len(${ex(ctx, a.expression)})); for __i, __v := range ${ex(ctx, a.expression)} { __s[__i] = __v }; return __s }())...`
        : ex(ctx, a)).join(", ");
      if (prop === "error" || prop === "warn") { ctx.uses.add("os"); return `fmt.Fprintln(os.Stderr, ${anyArgs()})`; }
      // console.log(`a ${x}`) -> fmt.Printf("a %v\n", x)
      if (c.arguments.length === 1 && ts.isTemplateExpression(c.arguments[0])) {
        const t = c.arguments[0] as ts.TemplateExpression;
        const parts = [t.head.text];
        const vals: string[] = [];
        for (const span of t.templateSpans) {
          parts.push("%v", span.literal.text);
          vals.push(ex(ctx, span.expression));
        }
        return `fmt.Printf(${JSON.stringify(parts.join("") + "\n")}, ${vals.join(", ")})`;
      }
      return `fmt.Println(${anyArgs()})`;
    }
    if (ts.isIdentifier(obj) && obj.text === "process" && prop === "exit") {
      ctx.uses.add("os"); return `os.Exit(${args()})`;
    }
    if (ts.isIdentifier(obj) && obj.text === "Math") {
      ctx.uses.add("math"); return `math.${prop[0].toUpperCase() + prop.slice(1)}(${args()})`;
    }
    if (ts.isIdentifier(obj) && obj.text === "JSON") {
      if (prop === "stringify") {
        ctx.uses.add("encoding/json");
        return `(func() string { b, _ := json.Marshal(${args()}); return string(b) }())`;
      }
      fail(ctx, c, `JSON.${prop} is not supported`);
      return `""`;
    }
    // channels as subjects: ch.emit(v) -> ch <- v;  ch.recv() -> <-ch;  ch.close() -> close(ch)
    if ((prop === "emit" || prop === "recv" || prop === "close") &&
        (typeNameOf(ctx, obj) ?? "").startsWith("chan ")) {
      if (prop === "emit") {
        if (c.arguments.length !== 1) { fail(ctx, c, "emit() takes exactly one argument"); return ""; }
        return `${ex(ctx, obj)} <- ${ex(ctx, c.arguments[0])}`;
      }
      if (prop === "recv") return `<-${ex(ctx, obj)}`;
      return `close(${ex(ctx, obj)})`;
    }
    // string methods -> strings package
    const strMethods: Record<string, string> = {
      toUpperCase: "ToUpper", toLowerCase: "ToLower",
      includes: "Contains", indexOf: "Index",
      split: "Split", trim: "TrimSpace",
      startsWith: "HasPrefix", endsWith: "HasSuffix",
      replaceAll: "ReplaceAll",
    };
    if (strMethods[prop]) { ctx.uses.add("strings"); return `strings.${strMethods[prop]}(${ex(ctx, obj)}${c.arguments.length ? ", " + args() : ""})`; }
    if (prop === "toString" && !c.arguments.length) { ctx.uses.add("fmt"); return `fmt.Sprintf("%v", ${ex(ctx, obj)})`; }
    // slice ops
    if (prop === "push") return `append(${ex(ctx, obj)}${c.arguments.length ? ", " + args() : ""})`;
    if (prop === "slice") {
      const a = c.arguments;
      if (a.length === 0) return `${ex(ctx, obj)}[:]`;
      if (a.length === 1) return `${ex(ctx, obj)}[${ex(ctx, a[0])}:]`;
      return `${ex(ctx, obj)}[${ex(ctx, a[0])}:${ex(ctx, a[1])}]`;
    }
    if (prop === "join") { ctx.uses.add("strings"); return `strings.Join(${ex(ctx, obj)}, ${args()})`; }
    if (prop === "map" || prop === "filter") return mapFilter(ctx, c, obj, prop);
    // Class.static(...) -> Class_static(...)
    if (ts.isIdentifier(obj) && ctx.classes.get(obj.text)?.statics.has(prop)) {
      return `${obj.text}_${prop}${typeArgs}(${args()})`;
    }
    return `${ex(ctx, obj)}.${memberName(ctx, obj, prop)}${typeArgs}(${args(methodDefsOf(ctx, obj, prop))})`;
  }

  if (callee.kind === ts.SyntaxKind.SuperKeyword) {
    fail(ctx, c, "super() is only valid as a constructor statement");
    return "";
  }

  return `${ex(ctx, callee)}${typeArgs}(${args()})`;
}

// method default-param table for obj.prop calls (instance or static — both
// register under the class name)
function methodDefsOf(ctx: Ctx, obj: ts.Expression, prop: string): (ts.Expression | undefined)[] | undefined {
  const t = ts.isIdentifier(obj) && ctx.classes.has(obj.text) ? obj.text : typeNameOf(ctx, obj);
  return t ? ctx.methodDefaults.get(baseType(t))?.get(prop) : undefined;
}

// call args with default-param padding: missing trailing args and explicit
// `undefined` are filled from the callee's declared defaults — Go has no
// optional params, so callers must always pass the full list
function padArgs(ctx: Ctx, c: ts.CallExpression, defs?: (ts.Expression | undefined)[]): string {
  if (!defs) {
    return c.arguments.map(a => ts.isSpreadElement(a) ? `${ex(ctx, a.expression)}...` : ex(ctx, a)).join(", ");
  }
  const out: string[] = [];
  const n = Math.max(c.arguments.length, defs.length);
  for (let i = 0; i < n; i++) {
    const a = c.arguments[i];
    if (!a) {
      if (defs[i]) { out.push(ex(ctx, defs[i])); continue; }
      if (i < defs.length) fail(ctx, c, `missing argument ${i + 1} — parameter has no default`);
      continue;
    }
    if (ts.isSpreadElement(a)) { out.push(`${ex(ctx, a.expression)}...`); continue; }
    if (ts.isIdentifier(a) && a.text === "undefined" && defs[i]) { out.push(ex(ctx, defs[i])); continue; }
    out.push(ex(ctx, a));
  }
  return out.join(", ");
}

// arr.map((x: int) => e)  ->  IIFE building a new slice
// arr.filter((x: int) => cond)  ->  IIFE keeping matches
function mapFilter(ctx: Ctx, c: ts.CallExpression, obj: ts.Expression, kind: "map" | "filter"): string {
  const cb = c.arguments[0];
  if (!cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) || cb.parameters.length < 1 || !ts.isIdentifier(cb.parameters[0].name)) {
    fail(ctx, c, `${kind} needs an arrow function with one named parameter`);
    return "nil";
  }
  const p = cb.parameters[0];
  const pType = p.type ? emitType(ctx, p.type) : "any";
  const arr = ex(ctx, obj);
  const resT = kind === "map"
    ? "[]" + (cb.body && ts.isBlock(cb.body) ? "any" : cb.type ? emitType(ctx, cb.type) : (ts.isArrowFunction(cb) && !ts.isBlock(cb.body) ? inferType(ctx, cb.body) : "any"))
    : "[]" + pType;
  const prevRet = ctx.retType; ctx.retType = undefined; ctx.inFunc++;
  let body: string;
  if (ts.isArrowFunction(cb) && !ts.isBlock(cb.body)) {
    const val = ex(ctx, cb.body);
    body = kind === "map" ? `out = append(out, ${val})` : `if ${val} { out = append(out, ${p.name.text}) }`;
  } else if (ts.isBlock(cb.body)) {
    const inner = new W();
    for (const s of cb.body.statements) { emitComments(ctx, inner, s); stmt(ctx, inner, s); }
    body = inner.text() + (kind === "filter" ? "" : "");
    // for map with block body the callback must `return` — inside IIFE the
    // append pattern doesn't apply; treat the last expression poorly. Emit a
    // nested func call instead for correctness.
    body = `out = append(out, func(${p.name.text} ${pType}) any {\n${inner.text()}\nreturn nil\n}(${p.name.text}))`;
  } else { body = ""; }
  ctx.retType = prevRet; ctx.inFunc--;
  return `(func() ${resT} {\nout := make(${resT}, 0, len(${arr}))\nfor _, ${p.name.text} := range ${arr} {\n${body}\n}\nreturn out\n}())`;
}

function objectLit(ctx: Ctx, o: ts.ObjectLiteralExpression, want?: ts.TypeNode): string {
  let typeName: string | undefined;
  if (want && ts.isTypeReferenceNode(want)) typeName = want.typeName.getText();
  else if (want && ts.isTypeLiteralNode(want)) typeName = emitType(ctx, want);
  if (!typeName) {
    fail(ctx, o, "object literals need a type annotation — e.g. `let p: Point = { x: 1 }`");
    typeName = "struct{}";
  }
  const fields = o.properties.map(p => {
    if (ts.isPropertyAssignment(p)) {
      const fname = p.name.getText();
      const goName = ctx.memberOf.get(typeName)?.has(fname) ? cap(fname) : fname;
      return `${goName}: ${ex(ctx, p.initializer)}`;
    }
    if (ts.isShorthandPropertyAssignment(p)) {
      const goName = ctx.memberOf.get(typeName)?.has(p.name.text) ? cap(p.name.text) : p.name.text;
      return `${goName}: ${p.name.text}`;
    }
    if (ts.isSpreadAssignment(p)) { fail(ctx, p, "spread in object literals is not supported"); return ""; }
    fail(ctx, p, "unsupported object literal member"); return "";
  }).filter(Boolean);
  return `${typeName}{${fields.join(", ")}}`;
}
