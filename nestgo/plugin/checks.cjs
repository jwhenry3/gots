// gots semantic checks — rules TypeScript's checker can't express.
// Shared by the emitter (src/emitter.ts) and the tsserver plugin
// (plugin/index.cjs). Plain CJS so tsserver can require() it.

const ts = require("typescript");

// Go integer type names (emitted form).
const INT_TYPES = new Set([
  "int", "int8", "int16", "int32", "int64",
  "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
  "byte", "rune",
]);

// Every spelling that maps to a Go int type -> its Go name.
const INT_SPELLINGS = {
  int: "int", int8: "int8", int16: "int16", int32: "int32", int64: "int64",
  uint: "uint", uint8: "uint8", uint16: "uint16", uint32: "uint32", uint64: "uint64",
  uintptr: "uintptr", byte: "byte", rune: "rune",
  Int: "int", Int8: "int8", Int16: "int16", Int32: "int32", Int64: "int64",
  Uint: "uint", Uint8: "uint8", Uint16: "uint16", Uint32: "uint32", Uint64: "uint64",
  Uintptr: "uintptr", Byte: "byte", Rune: "rune",
};

// `1e4`, `3.14`, `.5` -> float; `0x1e4`, `0b101`, `0o17`, `42` -> int
function isFloatLiteralText(text) {
  return !/^0[xXbBoO]/.test(text) && /[.eE]/.test(text);
}

function unwrapCast(e) {
  return ts.isAsExpression(e) || ts.isSatisfiesExpression(e) ? e.expression : e;
}

// declared-type source text -> Go int base name, or undefined.
// `Int32` -> "int32", `int32[]` -> "int32", `[]int32` -> "int32"
function goIntBaseOfTypeText(text) {
  let t = text.trim();
  while (t.endsWith("[]")) t = t.slice(0, -2);
  while (t.startsWith("[]")) t = t.slice(2);
  return INT_SPELLINGS[t];
}

// Walk the AST and produce the gots-specific diagnostics the TS checker
// cannot see (it can't inspect literal values). Each diag is a plain object
// shaped like ts.Diagnostic so both the emitter and the plugin can use it.
function gotsDiagnostics(sf) {
  const diags = [];
  const push = (node, messageText) => diags.push({
    file: sf, start: node.getStart(sf), length: node.getWidth(sf),
    messageText, category: ts.DiagnosticCategory.Error,
    code: 95001, source: "gots",
  });
  const visit = (n) => {
    // let x: Int32 = 1.5  /  let s: Int[] = [1.5]  /  param/property defaults
    if ((ts.isVariableDeclaration(n) || n.kind === ts.SyntaxKind.Parameter ||
         ts.isPropertyDeclaration(n)) && n.type && n.initializer) {
      const base = goIntBaseOfTypeText(n.type.getText(sf));
      if (base) {
        const inits = ts.isArrayLiteralExpression(n.initializer)
          ? [...n.initializer.elements] : [n.initializer];
        for (const raw of inits) {
          const lit = unwrapCast(raw);
          if (ts.isNumericLiteral(lit) && isFloatLiteralText(lit.getText(sf)))
            push(lit, `non-integer literal ${lit.getText(sf)} assigned to ${n.type.getText(sf)} (Go ${base})`);
        }
      }
    }
    // Int64(1.5) / int64(1.5)
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) &&
        INT_SPELLINGS[n.expression.text] && n.arguments.length === 1) {
      const a0 = unwrapCast(n.arguments[0]);
      if (ts.isNumericLiteral(a0) && isFloatLiteralText(a0.getText(sf)))
        push(a0, `non-integer literal ${a0.getText(sf)} cannot convert to ${n.expression.text} (Go ${INT_SPELLINGS[n.expression.text]})`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return diags;
}

module.exports = { INT_TYPES, INT_SPELLINGS, isFloatLiteralText, unwrapCast, goIntBaseOfTypeText, gotsDiagnostics };
