// gots ambient declarations — the "lib" of the gots language.
// Go's exact type system expressed as TypeScript types, so editors and tsc
// can typecheck .ts sources the same way lib.dom.d.ts describes the DOM.
// Every type here emits 1:1 to Go (see src/emitter.ts).

// ---- Go primitive types ----------------------------------------------------
// Each numeric type is BRANDED: `number & { __gots: "<go-name>" }` makes every
// Go type nominally distinct — `Int32` ≠ `Float64` ≠ `number`. Literals must
// be branded via conversions (`Int32(3)`) or casts (`3 as Int32`); arithmetic
// results come back as plain `number` and must be re-branded. The transpiler's
// checker reads the `__gots` literal to recover the exact Go type.

type int = number & { readonly __gots: "int" }
type int8 = number & { readonly __gots: "int8" }
type int16 = number & { readonly __gots: "int16" }
type int32 = number & { readonly __gots: "int32" }
type int64 = number & { readonly __gots: "int64" }
type uint = number & { readonly __gots: "uint" }
type uint8 = number & { readonly __gots: "uint8" }
type uint16 = number & { readonly __gots: "uint16" }
type uint32 = number & { readonly __gots: "uint32" }
type uint64 = number & { readonly __gots: "uint64" }
type uintptr = number & { readonly __gots: "uintptr" }
type float32 = number & { readonly __gots: "float32" }
type float64 = number & { readonly __gots: "float64" }
type byte = number & { readonly __gots: "byte" }
type rune = number & { readonly __gots: "rune" }
type complex64 = { re: float64; im: float64 }
type complex128 = { re: float64; im: float64 }
type bool = boolean & { readonly __gots: "bool" }

// Go's error interface — accepts new Error("...") values and allows e.Error()
interface error extends Error {
    Error?(): string
}

// `string`, `any`, `void` are already TypeScript keywords.

// ---- PascalCase aliases (Float64 -> float64, Int32 -> int32, ...) ----------
// `String`/`Number`/`Boolean` are omitted: they'd shadow TS's wrapper
// globals — use the `string`/`number`/`boolean`/`any` keywords instead.

type Int = int
type Int8 = int8
type Int16 = int16
type Int32 = int32
type Int64 = int64
type Uint = uint
type Uint8 = uint8
type Uint16 = uint16
type Uint32 = uint32
type Uint64 = uint64
type Uintptr = uintptr
type Float32 = float32
type Float64 = float64
type Byte = byte
type Rune = rune
type Complex64 = complex64
type Complex128 = complex128
type Bool = bool
type Any = any
// `Error` needs no alias — the global Error interface already resolves, and
// gots maps it to Go's `error` in type position.

// ---- Go composite helper types ----------------------------------------------

type ptr<T> = T
type Ptr<T> = T
type chan<T> = Channel<T>
type Chan<T> = Channel<T>

// Go maps == TS Map + index syntax. The index signature merges into the
// global Map interface so `m["k"]` / `for (const [k,v] of m)` both typecheck;
// index access yields `any` (method names can't be typed as V, a TS limit).
interface Map<K, V> {
    [key: string]: any
}
type map<K extends string | number | symbol, V> = globalThis.Map<K, V>

// ---- Channel — a Go channel in subject form ---------------------------------

declare class Channel<T> {
    constructor(capacity?: number)
    /** send — `ch <- v` */
    emit(value: T): void
    /** receive — `<-ch` */
    recv(): T
    close(): void
    /** `for (const v of ch)` -> `for v := range ch` */
    [Symbol.iterator](): Iterator<T>
}

// ---- Go builtins --------------------------------------------------------------

declare function len(v: any): int
declare function cap(v: any): int
// (returns are branded `int` — arithmetic/comparison against `number` is fine)
declare function append<T>(slice: T[], ...items: T[]): T[]
declare function copy<T>(dst: T[], src: T[]): int
declare function clear(v: any): void
declare function close<T>(ch: Channel<T>): void
declare function panic(v: any): never
declare function recover(): any
declare function print(...args: any[]): void
declare function println(...args: any[]): void
declare function max<T>(...args: T[]): T
declare function min<T>(...args: T[]): T
declare function complex(re: any, im: any): complex128
declare function real(c: any): float64
declare function imag(c: any): float64

// ---- Concurrency ----------------------------------------------------------------

/** `go(f, args...)` -> `go f(args...)` */
declare function go<F extends (...args: any[]) => any>(fn: F, ...args: Parameters<F>): void
/** `send(ch, v)` -> `ch <- v` (prefer `ch.emit(v)`) */
declare function send<T>(ch: Channel<T>, value: T): void
/** `recv(ch)` -> `<-ch` (prefer `ch.recv()`) */
declare function recv<T>(ch: Channel<T>): T

// ---- Constructor helpers (prefer `new Channel<T>()` / `new Map<K,V>()`) -----------

declare function newChan<T>(capacity?: number): Channel<T>
declare function newSlice<T>(capacity?: number): T[]
declare function newMap<K extends string | number | symbol, V>(): map<K, V>

// ---- Numeric type conversions — `int(x)` -> `int(x)` -------------------------------

declare function int(v: number): int
declare function int8(v: number): int8
declare function int16(v: number): int16
declare function int32(v: number): int32
declare function int64(v: number): int64
declare function uint(v: number): uint
declare function uint8(v: number): uint8
declare function uint16(v: number): uint16
declare function uint32(v: number): uint32
declare function uint64(v: number): uint64
declare function uintptr(v: number): uintptr
declare function float32(v: number): float32
declare function float64(v: number): float64
declare function byte(v: number): byte
declare function rune(v: number): rune
declare function bool(v: boolean): bool

// ---- PascalCase conversions — `Float64(x)` -> `float64(x)` -----------------

declare function Int(v: number): Int
declare function Int8(v: number): Int8
declare function Int16(v: number): Int16
declare function Int32(v: number): Int32
declare function Int64(v: number): Int64
declare function Uint(v: number): Uint
declare function Uint8(v: number): Uint8
declare function Uint16(v: number): Uint16
declare function Uint32(v: number): Uint32
declare function Uint64(v: number): Uint64
declare function Uintptr(v: number): Uintptr
declare function Float32(v: number): Float32
declare function Float64(v: number): Float64
declare function Byte(v: number): Byte
declare function Rune(v: number): Rune
declare function Bool(v: boolean): Bool
