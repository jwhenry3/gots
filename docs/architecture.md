# transpiler architecture

`gots build file.ts` / `gots build dir/`:

1. **Program** — `transpileFile` creates a real `ts.Program` rooted at every
   `.ts` under the build dir (recursive) + `gots/types/*.d.ts` + `../types/*.d.ts`
   (project-local declarations, e.g. `nestgo/types/nest.d.ts`). The genuine
   `TypeChecker` resolves types and forwards `getSemanticDiagnostics` as errors —
   branding makes `let x: Int32 = 3` a real TS2322.

2. **Pass 0** — walk ALL source files: enums, `memberOf`/`methodRets` tables
   (public members -> exported names), `funcRets`, and `collectDecorators`
   (controller route tables, module metadata, injectable set).

3. **Pass 1** — class metadata: `hasCtor`, statics, `embeds` (extends).

4. **Pass 2** — emit statements. Import decls feed `imports` + `aliasOf`
   (cross-package name -> `pkg.Name`). Top-level statements that aren't
   declarations collect into `func main()`.

5. **Header** — `package <dirname>` (`main` at build root) + merged imports:
   `ctx.uses` auto stdlib + user imports, usage-filtered, deduped. gofmt'd on write.

## Key data structures (Ctx)

- `varTypes` — scope-aware declared types (params, locals) for member/method
  resolution; falls back to `checkedGoType` (real checker) when misses.
- `memberOf`/`methodRets`/`funcRets` — name-keyed tables across ALL sibling
  files; `baseType()` strips `pkg.` before lookup.
- `classes` — name -> `{hasCtor, statics, embeds}`; class types emit `*T`
  except inside generic instantiation args.
- `aliasOf` — per-file imported ident -> qualified emit name. Powers `qname`
  (type refs, `&X{}`) and `pkgPrefixOf`/`qNew` (`NewX`, `(*X).M`).
- `pkgPath` — package name -> Go import path (`<module>/<relpath>` from the
  nearest `go.mod` upward).
- `ctrls`/`modules`/`injectables`/`nestAlias` — decorator metadata + the local
  alias the `nestgo/nest` import bound to (auto-imports when absent).

## Emit-time rules that trip people up

- `getText()` NEVER takes a SourceFile arg — nodes may be from sibling files.
- `try/finally` -> `defer` — single-call finally emits bare `defer call()`.
- `push` is statement-position only (`arr.push(x)` -> `arr = append(arr, x)`).
- Ternary requires a declared type — emits an IIFE.
- `new` on a `@Module` class or a bare `@Module` ident -> `NewX()` call.
- Import usage filter regexes the emitted body for `\balias\.` — generated
  references (decorator codegen, `fmt.Sprintf` from templates) keep imports alive
  via `ctx.uses`.

## IDE layer

`gots/plugin` (tsserver plugin) wraps `getSemanticDiagnostics` and appends
`checks.cjs` results — same rules as the CLI, code 95001. `nestgo/plugin` is a
copy — sync when updating. `tsconfig.json` registers `"plugins": [{"name":"./plugin"}]`.
