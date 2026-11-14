# GOTS (Goats) — write NestJS apps in TypeScript syntax, ship them as native Go

**gots** is a TypeScript-flavored language that transpiles to plain Go — the
same relationship TypeScript has to JavaScript, but targeting Go. Type
annotations are Go's exact types (`int32`, `float64`, `chan T`, `*T`, `error`),
and the output is ordinary, dependency-free, gofmt'd Go that builds and runs
with `go build` / `go run`.

**nestgo** is a real NestJS-style application written in gots: modules,
constructor-injected providers, controllers, DTO validation, guards,
interceptors, exception filters, and view rendering — on top of `nest`, a
hand-written Go framework package.

```ts
@Controller("/users")
export class UserController {
    constructor(private users: UsersService) {}       // DI by type, like NestJS

    @Get("/")
    findAll(c: Ptr<nest.Ctx>): [Any, Error] {
        return [this.users.findAll(), null]
    }
}
```

becomes

```go
func NewUserController(users *UsersService) *UserController { ... }

func (this *UserController) FindAll(c *nest.Ctx) (any, error) {
	return this.Users.FindAll(), nil
}
```

## Quick start

Prereqs: **Go 1.25+**, **Node 18+** (Node 26 runs `.ts` directly via type
stripping — that's how `node gots/src/cli.ts` works; on older Node, run it
through `tsx` or `ts-node`).

```bash
cd gots && npm install          # one dependency: typescript (^5.9)

# from the repo root:
npm run dev                     # transpile nestgo/src -> .go, then go run
                                # app listens on :3000 (PORT=3210 npm run dev)
```

Then hit the app:

```
GET    http://localhost:3000/api          rendered index.html view
GET    http://localhost:3000/api/users    list users (JSON)
GET    http://localhost:3000/api/users/1  one user
POST   http://localhost:3000/api/users    {"name","email"} — validated
PATCH  http://localhost:3000/api/users/1  partial update
DELETE http://localhost:3000/api/users/1  needs header x-api-key: secret
```

Other scripts: `npm run build` (transpile + `go build`), `npm run check`
(diagnostics only), `npm run examples` (transpile `gots/examples`),
`npm run clean` (delete generated `.go`), `npm run verify` (all of it).

## Writing gots — the 60-second tour

```ts
let count: Int32 = 3 as Int32              // -> var count int32 = 3
const pi: Float64 = 3.14159                // -> const pi float64 = 3.14159

func divide(a: Float64, b: Float64): [Float64, Error] {   // (float64, error)
    if (b === 0) { return [0, new Error("divide by zero")] }
    return [a / b, null]
}
let [q, err] = divide(10, 3)               // -> q, err := divide(10, 3)

const jobs = new Channel<Int>(4)         // -> make(chan int, 4)
jobs.emit(1); const j = jobs.recv()        // -> jobs <- 1 / <-jobs

this.mu.Lock()
try { return this.users } finally { this.mu.Unlock() }
// -> this.Mu.Lock(); defer this.Mu.Unlock(); return this.Users
```

- `Int32`, `Float64`, `Uint8`, `Bool`, `Byte`, `Rune`… are **real distinct
  types** (branded) — `Int32` won't assign to `Float64`. Brand literals with
  `as Int32` or convert with `Int32(3)`.
- Classes compile to `struct` + `NewX()` + methods; public members become
  exported Go names. `constructor(private x: T)` is supported.
- `throw` → `panic`, `try/finally` → `defer`, `try/catch` → defer/recover.
- `.push`, `.length`, `.includes`, `.slice`, template literals, `console.log`,
  `JSON.stringify` all map to their Go equivalents.

Full reference: [`docs/gots-language.md`](docs/gots-language.md),
[`docs/nest-framework.md`](docs/nest-framework.md),
[`docs/architecture.md`](docs/architecture.md), [`AGENTS.md`](AGENTS.md).

## IDE setup (making the editor speak gots)

Out of the box, a TS editor doesn't know `Int32`, `Channel<T>`, or the
decorators. Two mechanisms fix it — both already wired into the projects:

### 1. Ambient type declarations (`.d.ts`)

- `gots/types/gots.d.ts` — the language globals (`Int32`, `Channel`, `Ptr`,
  builtins, conversion functions)
- `gots/types/stdlib.d.ts` — Go stdlib module declarations (`fmt`, `strings`,
  `time`, `os`, `sync`, `strconv`, `encoding/json`, `net/http`…)
- `nestgo/types/nest.d.ts` — the framework API + decorator globals
  (`@Module`, `@Controller`, `@Injectable`, `@Get`…)
- `nestgo/types/gots.d.ts` + `stdlib.d.ts` — copies so the app project
  resolves them (each folder's `include` covers its own `types/`)

`tsconfig.json` `include`s these — nothing to configure.

### 2. The tsserver plugin (live diagnostics)

`tsserver` plugins can add errors on top of the real checker's — that's how
gots rules like `Int64(1.5)` show as squiggles in the editor, not just at
`gots build`. Both projects register it:

```jsonc
// nestgo/tsconfig.json (and gots/tsconfig.json)
"plugins": [{ "name": "./plugin" }]
```

**VS Code / Cursor / Windsurf:** open the `gots/` or `nestgo/` folder (or the
repo root — tsconfig discovery is per-directory). If diagnostics don't appear,
`Ctrl+Shift+P` → **TypeScript: Restart TS Server**. If prompted, either the
bundled or workspace TypeScript works — the plugin only needs the tsserver
API and `require("typescript")` resolves to the server's own instance.

You'll then see:

| What the editor shows | Source |
|---|---|
| `Type 'int32' is not assignable to type 'float64'` | real checker, via branding |
| `non-integer literal 1.5 cannot convert to Int64` | plugin, code 95001 |
| go-to-definition, completions, renames | real checker (free) |

**Note:** `nestgo/plugin/` is a self-contained copy of the gots plugin —
`checks.cjs` lives inside it so it needs no `node_modules`.

### Generated code

`gots build` writes `.go` next to each `.ts` (gitignored). If the IDE shows
stale results after edits, re-run `npm run build` — the `.go` is regenerated
deterministically.

## Repo layout

```
gots/                  the transpiler (node src/cli.ts build|run|check)
  src/emitter.ts       TS AST -> Go emitter — all the language logic
  src/checks.cjs       gots-specific diagnostics (shared CLI + plugin)
  plugin/              tsserver plugin for live editor diagnostics
  types/               language + Go stdlib declarations
  examples/            hello.ts / concurrency.ts

nestgo/                the framework + example app (module path: nestgo)
  nest/                framework package — hand-written Go
  types/nest.d.ts      framework + decorator declarations
  views/index.html     view template
  src/                 the app — folders are Go packages
    main.ts            bootstrap (nest.Create(AppModule) + Listen)
    app.module.ts      root @Module
    app.controller.ts  @Controller("/") — view
    core/              package core — ConfigService
    users/             package users — controller/service/guards/module
      dto/             package dto — Create/UpdateUserDto + Validate()

docs/                  language / framework / architecture reference
AGENTS.md              agent + developer memory (commands, rules, gotchas)
```

## Contributing / verifying changes

After touching `gots/src/emitter.ts`:

```bash
npm run verify      # typecheck + examples + full nestgo build
```

Then optionally `PORT=3210 npm run dev` and curl the endpoints — the
verification checklist in `AGENTS.md` lists the expected responses.
