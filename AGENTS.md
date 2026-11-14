# go-nest — agent memory

## What this repo is

A TypeScript-flavored language (**gots**) that compiles to plain Go with Go's
exact type semantics, plus **nestgo** — a real NestJS-style application written
in gots on top of a hand-written `nest` framework package.

The goal: write NestJS-shaped code (modules, DI, controllers, DTOs, guards,
interceptors, views) in `.ts` files, transpile to idiomatic dependency-free Go,
and `go build`/`go run` it like normal Go.

## Layout

```
gots/                   the transpiler
├── src/emitter.ts      TS AST -> Go emitter (~1700 lines, all logic lives here)
├── src/cli.ts          gots build|run|check <file.ts|dir>
├── src/checks.cjs      shared gots-only diagnostics (float literal -> int type)
├── plugin/             tsserver plugin — injects those diagnostics in the IDE
├── types/gots.d.ts     ambient Go types: Int32, Float64, Channel<T>, Ptr<T>...
├── types/stdlib.d.ts   `declare module` stubs for Go stdlib imports
└── examples/           hello.ts / concurrency.ts (+ generated .go — gitignored)

nestgo/                 the app + framework (module path: nestgo)
├── nest/               framework package — hand-written Go, NOT generated
├── types/nest.d.ts     framework API + decorator declarations
├── views/index.html    view template
├── plugin/             tsserver plugin copy for this project
└── src/                gots sources — FOLDERS ARE GO PACKAGES
    ├── main.ts             package main — bootstrap
    ├── app.module.ts       @Module root — imports CoreModule + UsersModule
    ├── app.controller.ts   @Controller("/") — renders the view
    ├── core/               package core — ConfigService provider
    └── users/              package users — controller/service/guards/module
        └── dto/            package dto — Create/UpdateUserDto + Validate()
```

## Commands

```bash
# preferred — root package.json scripts (run from repo root)
npm run dev         # transpile nestgo/src + go run (PORT env, default :3000)
npm run build       # transpile + go -C nestgo build ./...
npm run verify      # typecheck + examples + build
npm run check       # gots check nestgo/src
npm run clean       # delete generated .go next to .ts (keeps nestgo/nest)

# direct — from gots/
node src/cli.ts build ../nestgo/src/     # recursive — writes .go next to .ts
node src/cli.ts check <file|dir>         # typecheck only
node src/cli.ts run   <file|dir>         # transpile + go run

# Go side — from nestgo/
go build ./...         # framework + generated code
go run ./src/          # runs on :PORT (default :3000)

# typecheck the transpiler's own sources
cd gots && npx tsc -p tsconfig.json
```

Gotcha: generated `.go` files are **gitignored** — always rebuild after
checkout: `node src/cli.ts build ../nestgo/src/` from `gots/`.

## gots rules (the important ones)

- Type annotations ARE Go types: `Int32`, `Float64`, `Byte`, `Bool`, `Channel<T>`,
  `Ptr<T>`, `map<K,V>`, `T[]`, `[A, Error]` (multi-return).
- PascalCase types are **branded** (`number & {__gots:"int32"}`) — nominally
  distinct. Literals need `as Int` (erased) or `Int(3)` (conversion).
- Params loose / returns branded: stdlib fn params take `number`, returns keep
  brands. Arithmetic on brands returns `number` — re-brand with `as`.
- `throw e` -> `panic(e)`; `try/finally` -> `defer`; `try/catch` -> defer/recover
  (IIFE-wrapped when body has no escaping control flow).
- `arr.push(x)` -> `arr = append(arr, x)`; `.length` -> `len()`;
  template literals -> `fmt.Sprintf`; `parseInt` -> strconv IIFE (error dropped —
  use `strconv.Atoi` when you need the error).
- Channels are subjects: `new Channel<int>(4)`, `ch.emit(v)`, `ch.recv()`,
  `ch.close()`, `for (const x of ch)` -> `for range`.
- `interface` all-fields -> `struct` (exported fields + json tags);
  all-methods -> `interface`. `class` -> struct + `NewX()` + methods;
  `constructor(private x: T)` -> field + assignment (param props supported).
- Members are public -> **exported** (capitalized) in output; the emitter
  resolves `this.x`, `dto.x`, `(*C).M` via member tables + the real checker.

## Decorators (compile-time, erased)

`@Module({imports,controllers,providers,exports})` -> `func NewX() *nest.Module`
with wiring inlined. `@Controller("/users")` + `@Get/@Post/@Patch/@Delete(path)`
-> `nest.Controller(prefix, NewCtrl).Get(path, (*Ctrl).Method)`. `@Injectable()`
-> auto `NewX()` for DI. `@UseGuards`/`@UseInterceptors` (class or method) ->
`.Guards/.Interceptors` or `nest.WithGuard/WithInterceptor` route opts.
`@Module` class as a value (`AppModule` in `nest.Create(AppModule)`) -> `NewAppModule()`.

Decorators are ambient globals (declared in `nestgo/types/nest.d.ts`) — no import.

## Multi-package rules

- Each source DIRECTORY is a Go package; build-root dir = `package main`.
- `import {X} from "./same-dir"` -> stripped (same package).
- `import {X} from "../other"` or "./sub"` -> Go import `<go.mod module>/<relpath>`
  + references become `pkg.X` (aliasOf table). Import path derives from the
  nearest `go.mod` upward.
- `import * as n from "../pkg"` -> `import n "path"` — namespace alias honored.

## Framework API (nestgo/nest)

`nest.Create(mod)`, `app.SetGlobalPrefix`, `SetViews` (resolves glob by walking
ancestors — CWD-independent), `Listen`, `Inject[T]`, `Use/UseGuards/UseInterceptors/
UseGlobalFilters`. `Ctx`: `Param`, `Query`, `Header`, `SetHeader`, `Body`,
`Status`, `JSON`, `Render`, `Request`, `ResponseWriter`. `Res(status, body)` for
explicit status. HTTP exceptions: `BadRequestException`, `NotFoundException`,
`UnauthorizedException`, `ForbiddenException`, `ConflictException`,
`InternalServerErrorException`. DTO validation: implement `Validate() error` —
the framework calls it on body injection (the `Validatable` interface).

## Gotchas / known limitations

- `Int64(1.5)` errors at compile time (custom diag 95001 in CLI + plugin).
- Ternaries need a declared type (emitter emits an IIFE).
- `SetViews("views/*.html")` finds views from any CWD — don't regress it.
- `getText()` on AST nodes: NEVER pass a SourceFile — nodes may come from
  sibling files; no-arg `getText()` resolves each node's own file.
- Generic instantiation args don't get the class->`*` rule (`Inject<C>` ->
  `Inject[C]`), but type references do (`Channel<C>` -> `chan *C`).
- Handlers are method expressions `(*Ctrl).Method` — signature
  `(c *nest.Ctx[, body *Dto]) (any, error)`; framework reflects body type.
- `nestgo/plugin/` is a copy of `gots/plugin` for the app's tsconfig — keep in sync.

## Verification checklist after emitter changes

1. `node src/cli.ts build examples/hello.ts examples/concurrency.ts` — examples
   still emit + `go build` the outputs.
2. `node src/cli.ts build ../nestgo/src/` — zero diagnostics.
3. `cd ../nestgo && go build ./...` — clean.
4. `PORT=3210 go run ./src/` then curl: `/api` (view), `/api/users` CRUD,
   `DELETE` 401 without `x-api-key: secret`, 204 with.
