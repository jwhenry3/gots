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

// ---------- unsupported-construct diagnostics (code 95002) ----------------
// gots compiles a TS subset to Go — these constructs typecheck fine in TS but
// have no Go equivalent (or no mapping yet). Flag them early so the editor
// and `gots check` report them instead of emitting broken Go.

function hasMod2(n, kind) {
  return ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some(m => m.kind === kind);
}

// members of `T | null` / `T | undefined` / `T | null | undefined` are fine —
// they erase to *T. Anything else is a plain union, which Go can't express.
function isNullableUnion(u) {
  return u.types.every(t =>
    t.kind === ts.SyntaxKind.NullKeyword ||
    t.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isLiteralTypeNode(t) &&
      (t.literal.kind === ts.SyntaxKind.NullKeyword ||
       t.literal.kind === ts.SyntaxKind.UndefinedKeyword)));
}

// binding patterns that gots can destructure (flat, no defaults/rest/nesting)
function bindingOk(pat) {
  return pat.elements.every(el =>
    !ts.isOmittedExpression(el) && !el.dotDotDotToken && !el.initializer &&
    ts.isIdentifier(el.name) && (!el.propertyName || ts.isIdentifier(el.propertyName)));
}

function unsupportedDiagnostics(sf) {
  const diags = [];
  const push = (node, messageText) => diags.push({
    file: sf, start: node.getStart(sf), length: node.getWidth(sf),
    messageText, category: ts.DiagnosticCategory.Error,
    code: 95002, source: "gots",
  });
  const visit = (n) => {
    if (ts.isUnionTypeNode(n) && !isNullableUnion(n))
      push(n, "unions are not supported except 'T | null' -> *T (Go has no union types)");
    if (ts.isWithStatement(n)) push(n, "'with' is not supported");
    if (ts.isSpreadAssignment(n)) push(n, "spread in object literals is not supported");
    if (ts.isYieldExpression(n)) push(n, "generators are not supported — use channels or slices");
    if ((ts.isCommaListExpression(n) ||
         (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken)) &&
        !(n.parent && ts.isForStatement(n.parent)))
      push(n, "comma expressions are not supported");
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) ||
         ts.isFunctionExpression(n)) && n.asteriskToken)
      push(n, "generator functions are not supported");
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && !n.body)
      push(n, "overloads and 'declare' signatures are not supported — declare belongs in .d.ts");
    if (ts.isBinaryExpression(n) &&
        (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
         n.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
         n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken) &&
        !(n.parent && ts.isExpressionStatement(n.parent)))
      push(n, "'??='/'||='/'&&=' are only supported as statements");
    if (ts.isExportAssignment(n))
      push(n, "'export default <expr>' is not supported — the package itself is the default import; export by name");
    if (ts.isExportDeclaration(n)) {
      if (!n.exportClause) push(n, "'export *' is not supported — packages export by name capitalization");
      else for (const el of n.exportClause.elements)
        if (el.name.text === "default")
          push(el, "gots has no default exports — the package itself is the default import");
    }
    if ((ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) &&
        hasMod2(n, ts.SyntaxKind.StaticKeyword))
      push(n, "static accessors are not supported");
    if (ts.isClassStaticBlockDeclaration(n))
      push(n, "static blocks are not supported — use a package-level var or init()");
    if (n.kind === ts.SyntaxKind.Parameter &&
        (ts.isObjectBindingPattern(n.name) || ts.isArrayBindingPattern(n.name)) &&
        !bindingOk(n.name))
      push(n.name, "destructured params support flat renames only — no nesting, defaults, or rest");
    if ((ts.isVariableDeclaration(n)) &&
        (ts.isObjectBindingPattern(n.name) || ts.isArrayBindingPattern(n.name)) &&
        !bindingOk(n.name))
      push(n.name, "destructuring supports flat renames only — no nesting, defaults, or rest");
    if (ts.isPropertyDeclaration(n) && ts.isPrivateIdentifier(n.name))
      push(n, "#private fields are not supported — use the 'private' keyword");
    if (ts.isPropertyDeclaration(n) && hasMod2(n, ts.SyntaxKind.AccessorKeyword))
      push(n, "auto-accessors are not supported — write explicit get/set");
    if (ts.isModuleDeclaration(n))
      push(n, "namespaces/modules are not supported — one directory is one Go package");
    if (ts.isIdentifier(n) && n.text === "arguments" &&
        !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n))
      push(n, "'arguments' is not supported — use rest params (...args)");
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) &&
        (n.expression.text === "eval" || n.expression.text === "Function"))
      push(n, `'${n.expression.text}' is not supported`);
    if (ts.isRegularExpressionLiteral(n))
      push(n, "regex literals are not supported — use the regexp package");
    if (ts.isForOfStatement(n) && n.awaitModifier)
      push(n, "'for await' is not supported — range over a channel");
    // AwaitUsing is a mask (Const|Using) — the Using bit alone covers both
    if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.Using))
      push(n, "'using' declarations are not supported — call Close() or defer it");
    if (ts.isAsExpression(n) && ts.isTypeReferenceNode(n.type) &&
        n.type.typeName.getText() === "const")
      push(n, "'as const' is not supported — declare a const or a literal type");
    if (ts.isImportEqualsDeclaration(n))
      push(n, "'import x = require()' is not supported — use ES import syntax");
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) &&
        (n.expression.text === "Channel" || n.expression.text === "Map" ||
         n.expression.text === "Array") && !n.typeArguments?.length)
      push(n, `new ${n.expression.text}<T>(...) needs its type arguments`);
    if (ts.isIndexSignatureDeclaration(n) && n.parent && ts.isClassLike(n.parent))
      push(n, "index signatures are not supported on classes");
    if (ts.isTypePredicateNode(n))
      push(n, "type predicates ('x is T'/'asserts x') are not supported");
    if (ts.isConditionalTypeNode(n) || ts.isMappedTypeNode(n) ||
        ts.isTemplateLiteralTypeNode(n) || ts.isInferTypeNode(n) ||
        ts.isIndexedAccessTypeNode(n))
      push(n, "advanced type operators (conditional/mapped/template/infer/indexed) are not supported");
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return diags;
}

function allDiagnostics(sf) {
  return [...gotsDiagnostics(sf), ...unsupportedDiagnostics(sf)];
}

module.exports = { INT_TYPES, INT_SPELLINGS, isFloatLiteralText, unwrapCast, goIntBaseOfTypeText, gotsDiagnostics, unsupportedDiagnostics, allDiagnostics };
