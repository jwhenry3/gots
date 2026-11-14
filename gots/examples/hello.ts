// gots example — TypeScript syntax, Go's exact type system.
// Run:  node src/cli.ts run examples/hello.ts

import "fmt"
import * as strings from "strings"

// Go primitive types are nominally distinct (Int32 ≠ Float64 ≠ number):
// literals get brands via `as` casts (erased) or conversions (kept in output).
let count: Int32 = 3 as Int32
const pi: Float64 = 3.14159 as Float64
let ok: Bool = true as Bool
let name: string = "gots"
var raw: Byte = 0x61 as Byte

// composite Go types in TS syntax
let scores: Int[] = [90 as Int, 85 as Int, 77 as Int]
let ages: map<string, Int> = new Map<string, Int>()
let cb: (x: Int) => string

// interface with only fields -> struct; with only methods -> interface
interface Point { x: Int; y: Int }
interface Stringer { String(): string }

enum Color { Red, Green, Blue }

// class -> struct + NewPoint-style ctor + methods (`this` is a Go receiver)
class Vec implements Stringer {
    x: Int
    y: Int

    constructor(x: Int, y: Int) {
        this.x = x
        this.y = y
    }

    String(): string {
        return `Vec(${this.x}, ${this.y})`
    }

    add(o: Vec): Vec {
        // x+y is `number` after arithmetic — re-brand for the Int param
        return new Vec((this.x + o.x) as Int, (this.y + o.y) as Int)
    }

    static zero(): Vec {
        return new Vec(0 as Int, 0 as Int)
    }
}

// generics -> Go generics
function identity<T>(v: T): T {
    return v
}

// tuple return -> Go's (T, error) idiom
function divide(a: Float64, b: Float64): [Float64, Error] {
    if (b === 0) {
        return [0 as Float64, errorsNew("division by zero")]
    }
    return [Float64(a / b), null]
}

function errorsNew(m: string): Error {
    return new Error(m)
}

function describe(p: Point): string {
    return `${p.x}:${p.y}`
}

function main() {
    console.log(`hello from ${name}, count=${count}, pi=${pi}, ok=${ok}, raw=${raw}`)

    let v = new Vec(1 as Int, 2 as Int)
    let w = v.add(new Vec(3 as Int, 4 as Int))
    console.log(w.String())
    console.log(Vec.zero().String())

    let p: Point = { x: 7 as Int, y: 9 as Int }
    console.log(describe(p))

    // slices, maps, builtins
    ages["ada"] = 36
    scores = append(scores, 100 as Int)
    for (let i = 0; i < scores.length; i++) {
        console.log(`score[${i}] = ${scores[i]}`)
    }
    for (const s of scores.slice(1, 3)) {
        console.log(`of ${s}`)
    }
    for (const [k, v] of ages) {
        console.log(`${k} is ${v}`)
    }

    // control flow
    if (count > 2 && ok) {
        console.log("big")
    } else if (count > 1) {
        console.log("mid")
    } else {
        console.log("small")
    }

    switch (identity<Color>(Color.Green)) {
    case Color.Red:
        console.log("red")
    case Color.Green:
        console.log("green")
    default:
        console.log("other")
    }

    // generics + tuple return + error check
    let n = identity<Int>(42 as Int)
    let [q, err] = divide(10 as Float64, 0 as Float64)
    if (err !== null) {
        console.log(`divide failed: ${err}`)
    } else {
        console.log(`10/2 = ${q}, n=${n}`)
    }

    // try/catch -> defer/recover
    try {
        throw new Error("boom")
    } catch (e) {
        console.log(`caught: ${e}`)
    } finally {
        console.log("cleanup")
    }

    // stdlib pass-through via namespace import
    console.log(strings.ToUpper("done"))
}
