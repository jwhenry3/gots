// Go standard-library module declarations for gots imports:
//   import "fmt"                    -> import "fmt"
//   import * as strings from "strings" -> import "strings"
//   import { Println } from "fmt"   -> import . "fmt"

declare module "fmt" {
    export function Print(...a: any[]): [int, error]
    export function Printf(format: string, ...a: any[]): [int, error]
    export function Println(...a: any[]): [int, error]
    export function Sprint(...a: any[]): string
    export function Sprintf(format: string, ...a: any[]): string
    export function Sprintln(...a: any[]): string
    export function Errorf(format: string, ...a: any[]): error
    export function Fprint(w: any, ...a: any[]): [int, error]
    export function Fprintf(w: any, format: string, ...a: any[]): [int, error]
    export function Fprintln(w: any, ...a: any[]): [int, error]
    export function Scanf(format: string, ...a: any[]): [int, error]
    export function Scanln(...a: any[]): [int, error]
}

declare module "errors" {
    export function New(text: string): error
    export function Is(err: error, target: error): bool
    export function As(err: error, target: any): bool
}

declare module "strings" {
    export function ToUpper(s: string): string
    export function ToLower(s: string): string
    export function Contains(s: string, substr: string): bool
    export function ContainsAny(s: string, chars: string): bool
    export function Index(s: string, substr: string): int
    export function Split(s: string, sep: string): string[]
    export function Join(elems: string[], sep: string): string
    export function TrimSpace(s: string): string
    export function Trim(s: string, cutset: string): string
    export function HasPrefix(s: string, prefix: string): bool
    export function HasSuffix(s: string, suffix: string): bool
    export function ReplaceAll(s: string, old: string, replacement: string): string
    export function Repeat(s: string, count: number): string
    export function Count(s: string, substr: string): int
}

declare module "time" {
    export const Nanosecond: int64
    export const Microsecond: int64
    export const Millisecond: int64
    export const Second: int64
    export const Minute: int64
    export const Hour: int64
    export function Sleep(d: number): void
    export function Now(): Time
    export function Since(t: Time): int64
    export class Time {
        Unix(): int64
        Format(layout: string): string
        Add(d: number): Time
        Sub(u: Time): int64
        Before(u: Time): bool
        After(u: Time): bool
    }
}

declare module "os" {
    export const Args: string[]
    export const Stdin: any
    export const Stdout: any
    export const Stderr: any
    export function Exit(code: number): never
    export function Getenv(key: string): string
    export function Setenv(key: string, value: string): error
    export function ReadFile(name: string): [byte[], error]
    export function WriteFile(name: string, data: number[], perm: number): error
}

declare module "strconv" {
    export function Atoi(s: string): [int, error]
    export function Itoa(i: number): string
    export function ParseFloat(s: string, bitSize: number): [float64, error]
    export function FormatFloat(f: number, fmt: string, prec: number, bitSize: number): string
    export function ParseInt(s: string, base: number, bitSize: number): [int64, error]
    export function ParseBool(s: string): [bool, error]
}

declare module "math" {
    export const Pi: float64
    export const E: float64
    export function Floor(x: number): float64
    export function Ceil(x: number): float64
    export function Round(x: number): float64
    export function Sqrt(x: number): float64
    export function Pow(x: number, y: number): float64
    export function Abs(x: number): float64
    export function Max(x: number, y: number): float64
    export function Min(x: number, y: number): float64
    export function Mod(x: number, y: number): float64
    export function Log(x: number): float64
    export function Exp(x: number): float64
    export function Sin(x: number): float64
    export function Cos(x: number): float64
    export function Tan(x: number): float64
}

declare module "encoding/json" {
    export function Marshal(v: any): [byte[], error]
    export function MarshalIndent(v: any, prefix: string, indent: string): [byte[], error]
    export function Unmarshal(data: any, v: any): error
}

declare module "sync" {
    export class Mutex {
        Lock(): void
        Unlock(): void
        TryLock(): bool
    }
    export class RWMutex {
        Lock(): void
        Unlock(): void
        RLock(): void
        RUnlock(): void
    }
    export class WaitGroup {
        Add(delta: number): void
        Done(): void
        Wait(): void
    }
    export class Once {
        Do(f: () => void): void
    }
}

declare module "sort" {
    export function Ints(a: int[]): void
    export function Strings(a: string[]): void
    export function Float64s(a: float64[]): void
    export function Slice(x: any, less: (i: int, j: int) => bool): void
    export function IsSorted(x: any): bool
}

declare module "slices" {
    export function Sort<T>(s: T[]): void
    export function Contains<T>(s: T[], v: T): bool
    export function Index<T>(s: T[], v: T): int
    export function Reverse<T>(s: T[]): void
}

declare module "log" {
    export function Print(v: any): void
    export function Printf(format: string, ...a: any[]): void
    export function Println(v: any): void
    export function Fatal(v: any): never
    export function SetFlags(flag: number): void
}

declare module "io" {
    export function ReadAll(r: any): [byte[], error]
    export function Copy(dst: any, src: any): [int64, error]
}

declare module "net/http" {
    export function ListenAndServe(addr: string, handler: any): error
    export function Handle(pattern: string, handler: any): void
    export function HandleFunc(pattern: string, handler: (w: any, r: any) => void): void
    export function Get(url: string): [any, error]
    export function Post(url: string, contentType: string, body: any): [any, error]
}
