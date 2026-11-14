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
| `a ?? b` | nil-guarded IIFE; non-nilable `a` collapses to `a` |
| `a?.b`, `a?.[k]`, `a?.f(x)` | nil-guarded IIFE (single eval via temp); `a?.b ?? c` fuses into one check |
| `a \|\| b`, `a && b` (non-bool) | JS truthiness via zero-value IIFE (`""`, `0`, `nil`); bool operands stay `\|\|`/`&&` |
| `a ??= b`, `a \|\|= b`, `a &&= b` (stmts) | `if a == nil` / falsy / truthy `{ a = b }` |
| `k in m` | `_, ok := m[k]`; `i in slice` -> bounds check |
| `x instanceof C` | `_, ok := x.(*C)` IIFE; statically non-nilable LHS -> `false` |
| `typeof x` | folds to `"number"`/`"string"`/`"boolean"`/`"function"`/`"object"` when known; `any` -> `fmt.Sprintf("%T", x)` (Go type names) |
| `label: for` + `break label`/`continue label` | direct (Go labels) |
| `[...a, x, ...b]` | `append(append(append([]T{}, a...), x), b...)` — copy semantics |
| `f(...xs)` | `f(xs...)`; into `console.*` -> `[]any` conversion |
| `f(x = d)` / `f(a, ..., z = d)` | signature drops defaults; **call sites pad** (`f()` -> `f(d)`), `undefined` arg -> default |
| `f({a, b}: T)` | `func f(__p0 T) { a, b := __p0.A, __p0.B }` |
| `let {a, b} = o` | temp + `a := __t.A`; `let [a,b] = s` (non-call) -> index destructure |
| `get y(): T` / `set y(v)` | `func Y() T` / `func SetY(v T)`; `o.y` -> `o.Y()`, `o.y = v` -> `o.SetY(v)`, `o.y += v` -> `o.SetY(o.Y() + v)` |
| `interface { [k: K]: V }` | `type X map[K]V` |

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

Plain unions (use `T|null`), nested/rest/defaults inside binding patterns,
spread in object literals, `??=`/`||=`/`&&=` in expression position,
static accessors, comma expressions, `with`, getters/setters on interfaces.

## JS-semantics notes

- `typeof x` on `any` yields Go type names (`int`, `*User`) — not JS names.
- Truthiness on `any`-typed values is a nil check — `""`/`0` inside `any`
  read as truthy (unlike JS). Keep `||`/`&&` operands concretely typed.
- Default params pad at the call site — a default referencing an earlier
  param (`f(a, b = a)`) won't compile.
- TS "always truthy/falsy/nullish" lints (TS2869–2873) are suppressed at
  build; the editor may still underline constant `||`/`&&`/`??` operands.
