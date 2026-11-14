interface Config { [k: string]: string }

class User {
    name: string = "";
    private _age: Int = 0 as Int;
    private _title: string = "";

    get age(): Int { return this._age }
    set age(v: Int) { this._age = v }
    get title(): string { return this._title }
    set title(v: string) { this._title = v }
}

function greet(name: string = "world", punct: string = "!"): string {
    return `hello ${name}${punct}`
}

function opt(u: Ptr<User>): string {
    return u?.name ?? "anonymous"
}

function main() {
    // ?? and ?.
    let cfg: Map<string, string> = new Map<string, string>()
    const v1: Map<string, string> = cfg ?? new Map<string, string>()
    const nm = opt(null)

    // default params
    console.log(greet())           // pads both defaults
    console.log(greet("gots"))     // pads punct
    console.log(greet("a", "?"))

    // || / && on non-bools
    let e = ""
    const s1 = e || "fallback"
    let ok = "ok"
    const s2 = ok && "then"
    let n = 0
    const n1 = n || 42
    let s3 = ""
    s3 ||= "assigned"
    s3 &&= "still"
    let p: Ptr<User> = null
    p ??= new User()

    // spread
    const base = [1, 2, 3]
    const more = [...base, 4, 5]
    const mixed = [0, ...base, 9]

    // rest + spread call
    console.log(...more)

    // typeof / instanceof / in
    const ix: Int = 42 as Int
    var x: Any = ix
    if (typeof ix === "number") { console.log("num") }
    if (x instanceof User) { console.log("user") }
    if (!(x instanceof User)) { console.log("not user") }
    const m = new Map<string, Int>()
    if ("k" in m) { console.log("has k") }

    // getters/setters
    const u = new User()
    u.age = 30 as Int
    u.title = "dr"
    u.title += "!"
    console.log(u.age, u.title)

    console.log(v1, nm, s1, s2, n1, s3, p, mixed)
}

function dist({ x, y }: { x: Int; y: Int }): Int {
    return (x * x + y * y) as Int
}
