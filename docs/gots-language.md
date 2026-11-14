# gots — language reference

TypeScript syntax, Go's exact semantics. The input is literally valid TypeScript
(parsed by Microsoft's compiler); the output is gofmt'd, dependency-free Go.

## Types

| gots | Go |
|---|---|
| `int`, `int8`…`uint64`, `uintptr`, `float32/64`, `complex64/128`, `byte`, `rune`, `bool`, `string`, `error`, `any` | identical |
| `Int`/`Int8`…`Int64`, `Uint`…, `Float32/64`, `Byte`, `Rune`, `Bool`, `Any`, `Error` | PascalCase aliases -> same Go types |
| `number`, `boolean`, `string`, `any` (TS keywords) | `float64`, `bool`, `string`, `any` |
| `T[]`, `[n]T` | `[]T`, `[n]T` |
| `map<K,V>`, `Map<K,V>` | `map[K]V` |
| `Channel<T>` | `chan T` |
| `Ptr<T>` | `*T` |
| `[A, B]` tuple (return position) | `(A, B)` |
| `(a: T) => R` | `func(a T) R` |
| `T \| null` | `*T` |

### Branding

`type int32 = number & { readonly __gots: "int32" }` — every numeric/bool type is
nominally distinct. `Int32` ≠ `Float64` ≠ `number`. The `__gots` literal carries
the Go type name so the emitter recovers it through real checker inference.

- `let x: Int32 = 3` — ERROR (literal is `number`). Use `3 as Int32` (cast
  erased -> `3`) or `Int32(3)` (conversion -> `int32(3)`).
- `Int64(1.5)` — custom error 95001 (non-integer literal), in CLI and IDE.
- Stdlib params are loose (`number`) so `10 * time.Millisecond` works; returns
  stay branded. Arithmetic results are plain `number` — re-brand when needed.

## Statements / expressions

| gots | Go |
|---|---|
| `let`/`const`/`var` | `x :=`/`var`/`const` (const only for const exprs) |
| `let [a, err] = f()` | `a, err := f()` |
| `if`/`else`, `for`, `for..of`, `switch`, `break`/`continue` | direct |
| `throw e` | `panic(e)` |
| `try/catch` | defer/recover; IIFE-wrapped unless body escapes |
| `try { } finally { f() }` | `defer f()` (single call) or `defer func(){..}()` |
| `async`/`await`/`Promise<T>` | erased — Go calls are synchronous |
| `` `x ${a}` `` | `fmt.Sprintf("x %v", a)` |
| `arr.push(x)` (stmt) | `arr = append(arr, x)` |
| `.length`, `.includes`, `.slice`, `.map`, `.filter`, `.forEach` | `len`, `strings.Contains`, slice, loop IIFEs |
| `parseInt`, `parseFloat`, `String(x)` | strconv wrappers |
| `console.log` | `fmt.Println` |
| `JSON.stringify` | `json.Marshal` |
| `go(f, args...)` | `go f(args...)` |
| `new Channel<T>(n)`, `new Map<K,V>()`, `new Array<T>(n)` | `make(chan/map/slice)` |
| `ch.emit(v)`, `ch.recv()`, `ch.close()` | `ch <- v`, `<-ch`, `close(ch)` |
| `new Error(m)` | `errors.New(m)` |
| `delete m[k]` | `delete(m, k)` |

## Declarations

- `class` -> `type X struct` + `func NewX(...)` + receiver methods. Members are
  public -> exported Go names; fields get `json:"name"` tags.
- `constructor(private x: T)` -> field `X *T` + `this.X = x` (param properties).
- `extends Base` -> `*Base` embedded; `super(...)` -> `NewBase(...)`.
- `static` members -> package-level `X_member` / `func X_method`.
- `interface` all-fields -> `struct`; all-methods -> `interface`; mixed -> error.
- `enum` -> `type E int` + `const` block; `E.Member` -> `Member`.
- `Class.prototype.method` -> `(*Class).Method` (method expression).
- `function f<T>(x: T): T` -> `func f[T any](x T) T`.

## Imports

- `import "fmt"` -> `import "fmt"` (use as `fmt.X`)
- `import * as s from "strings"` -> same, alias
- `import {A,B} from "x"` -> `import . "x"` (dot-import)
- `import {X} from "./sibling"` -> stripped — same Go package
- `import {X} from "./sub"` / `"../pkg"` -> `import "module/relpath"`,
  `X` -> `pkg.X`
- Unused imports are dropped (Go rejects them).

## Errors (not yet supported — fail with diagnostics)

Default params, rest params, plain unions (use `T|null`), `??`, `?.`,
destructuring params, getters/setters, index signatures, labeled break/continue,
spread in most positions.
