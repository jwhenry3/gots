// Removes generated .go files — those emitted next to a .ts sibling by the
// transpiler. Hand-written Go (nestgo/nest/*.go) has no .ts twin and is kept.
import fs from "node:fs";
import path from "node:path";

const roots = ["nestgo/src", "gots/examples"];
let n = 0;
const walk = d => {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (e.name.endsWith(".go") && fs.existsSync(p.replace(/\.go$/, ".ts"))) {
      fs.rmSync(p);
      n++;
    }
  }
};
roots.forEach(walk);
console.log(`removed ${n} generated .go file(s)`);
