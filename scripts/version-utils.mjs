import { parseAst } from "rolldown/parseAst";

export const PB_CONFIG_MAX_BYTES = 256 * 1024;
const MAX_SOURCE_NESTING_DEPTH = 128;

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function frozenMap(entries) {
  const map = Object.create(null);
  for (const [key, value] of Object.entries(entries)) map[key] = value;
  return Object.freeze(map);
}

const PAPERBACK_ENUMS = frozenMap({
  ContentRating: frozenMap({
    EVERYONE: "SAFE",
    MATURE: "MATURE",
    ADULT: "ADULT",
  }),
  SourceIntents: frozenMap({
    NONE: 0,
    MANGA_CHAPTERS: 1,
    CHAPTER_PROVIDING: 1,
    MANGA_PROGRESS: 2,
    MANGA_PROGRESS_PROVIDING: 2,
    PROGRESS_PROVIDING: 2,
    DISCOVER_SECIONS: 4,
    DISCOVER_SECIONS_PROVIDING: 4,
    DISCOVER_SECTION_PROVIDING: 4,
    COLLECTION_MANAGEMENT: 8,
    MANAGED_COLLECTION_PROVIDING: 8,
    CLOUDFLARE_BYPASS_REQUIRED: 16,
    CLOUDFLARE_BYPASS_PROVIDING: 16,
    SETTINGS_UI: 32,
    SETTINGS_FORM_PROVIDING: 32,
    MANGA_SEARCH: 64,
    SEARCH_RESULTS_PROVIDING: 64,
    SEARCH_RESULT_PROVIDING: 64,
  }),
});

const STATIC_MARKER = Symbol("static marker");
const MAX_EVALUATION_DEPTH = 64;
const MAX_EXPRESSION_VISITS = 50_000;
const MAX_CONTAINER_ENTRIES = 20_000;
const MAX_EXPANDED_OUTPUT_BYTES = 256 * 1024;

function sourceSizeError(sourcePath) {
  return new Error(
    `${sourcePath} exceeds the maximum pbconfig source size of ${PB_CONFIG_MAX_BYTES} bytes (256 KiB).`,
  );
}

export function assertPBConfigSize(sourceText, sourcePath = "pbconfig.ts") {
  if (Buffer.byteLength(sourceText, "utf8") > PB_CONFIG_MAX_BYTES) {
    throw sourceSizeError(sourcePath);
  }
}

function sourceSyntaxError(sourcePath, detail) {
  return new Error(
    `${sourcePath} contains unsupported or unsafe syntax before parsing (${detail}).`,
  );
}

function guardSourceSyntax(sourceText, sourcePath) {
  const stack = [];
  let state = "normal";
  for (let index = 0; index < sourceText.length; index += 1) {
    const character = sourceText[index];

    if (state === "single" || state === "double") {
      if (character === "\\") {
        if (index + 1 >= sourceText.length)
          throw sourceSyntaxError(sourcePath, "unterminated string");
        index += 1;
      } else if (
        (state === "single" && character === "'") ||
        (state === "double" && character === '"')
      ) {
        state = "normal";
      }
      continue;
    }

    if (state === "line-comment") {
      if (character === "\n" || character === "\r") state = "normal";
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && sourceText[index + 1] === "/") {
        state = "normal";
        index += 1;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      state = character === "'" ? "single" : "double";
      continue;
    }
    if (character === "`") throw sourceSyntaxError(sourcePath, "template literal");
    if (character === "/") {
      const next = sourceText[index + 1];
      if (next === "/") {
        state = "line-comment";
        index += 1;
        continue;
      }
      if (next === "*") {
        state = "block-comment";
        index += 1;
        continue;
      }
      throw sourceSyntaxError(sourcePath, "unsupported slash expression");
    }

    if (character === "(" || character === "[" || character === "{") {
      if (stack.length >= MAX_SOURCE_NESTING_DEPTH) {
        throw sourceSyntaxError(sourcePath, `nesting depth exceeds ${MAX_SOURCE_NESTING_DEPTH}`);
      }
      stack.push(character === "(" ? ")" : character === "[" ? "]" : "}");
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      if (stack.pop() !== character) throw sourceSyntaxError(sourcePath, "mismatched delimiters");
    }
  }

  if (state === "single" || state === "double") {
    throw sourceSyntaxError(sourcePath, "unterminated string");
  }
  if (state === "block-comment") throw sourceSyntaxError(sourcePath, "unterminated comment");
  if (stack.length > 0) throw sourceSyntaxError(sourcePath, "unclosed delimiters");
}

class StaticEvaluationBudget {
  constructor(sourcePath) {
    this.sourcePath = sourcePath;
    this.expressionVisits = 0;
    this.containerEntries = 0;
    this.expandedOutputBytes = 0;
  }

  fail(kind) {
    throw new Error(
      `${this.sourcePath} exceeds the static metadata complexity/size budget (${kind}).`,
    );
  }

  visit(expression, depth) {
    if (depth > MAX_EVALUATION_DEPTH) this.fail("recursion depth");
    this.expressionVisits += 1;
    if (this.expressionVisits > MAX_EXPRESSION_VISITS) this.fail("expression visits");
    if (!expression) this.fail("invalid expression");
  }

  container(entries, kind) {
    this.containerEntries += entries;
    if (this.containerEntries > MAX_CONTAINER_ENTRIES) {
      this.fail(`${kind} entries`);
    }
    this.output(kind === "array" ? 2 + Math.max(0, entries - 1) : 2);
  }

  output(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) this.fail("invalid output size");
    this.expandedOutputBytes += bytes;
    if (this.expandedOutputBytes > MAX_EXPANDED_OUTPUT_BYTES) {
      this.fail("expanded output size");
    }
  }

  arrayEntry() {
    this.output(1);
  }

  objectKey(name, index) {
    this.output(jsonStringBytes(name) + 1 + (index === 0 ? 0 : 1));
  }

  scalar(value) {
    if (typeof value === "string") {
      this.output(jsonStringBytes(value));
    } else if (value === null) {
      this.output(4);
    } else if (typeof value === "boolean") {
      this.output(value ? 4 : 5);
    } else if (typeof value === "number") {
      this.output(Buffer.byteLength(String(value), "utf8"));
    } else {
      this.fail("unsupported scalar");
    }
  }
}

function jsonStringBytes(value) {
  let bytes = 2;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0x22 || codePoint === 0x5c) bytes += 2;
    else if (codePoint <= 0x1f) {
      bytes +=
        codePoint === 0x08 ||
        codePoint === 0x09 ||
        codePoint === 0x0a ||
        codePoint === 0x0c ||
        codePoint === 0x0d
          ? 2
          : 6;
    } else if (codePoint >= 0xd800 && codePoint <= 0xdfff) bytes += 6;
    else bytes += Buffer.byteLength(character, "utf8");
  }
  return bytes;
}

export function compareSourceIds(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodeUnit = left.charCodeAt(index);
    const rightCodeUnit = right.charCodeAt(index);
    if (leftCodeUnit !== rightCodeUnit) return leftCodeUnit - rightCodeUnit;
  }
  return left.length - right.length;
}

function parseProgram(sourceText, sourcePath) {
  assertPBConfigSize(sourceText, sourcePath);
  guardSourceSyntax(sourceText, sourcePath);
  try {
    return parseAst(sourceText, { lang: "ts" }, sourcePath);
  } catch (error) {
    throw new Error(
      `${sourcePath} could not be parsed while reading its metadata: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function defaultObject(program, sourcePath) {
  const exports = program.body.filter((statement) => statement.type === "ExportDefaultDeclaration");
  if (exports.length !== 1) {
    throw new Error(`${sourcePath} does not declare a literal version in its default export.`);
  }

  const declaration = unwrapExpression(exports[0].declaration);
  if (declaration?.type !== "ObjectExpression") {
    throw new Error(`${sourcePath} does not export an object with a literal version.`);
  }
  return declaration;
}

function staticObjectProperties(object, sourcePath) {
  const properties = [];
  const names = new Set();
  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      throw new Error(`${sourcePath} default export must not contain object spreads.`);
    }
    if (property.type !== "Property") {
      throw new Error(`${sourcePath} contains an unsupported object property.`);
    }
    if (property.computed === true) {
      throw new Error(`${sourcePath} default export must not contain computed properties.`);
    }
    if (
      property.kind !== "init" ||
      property.method === true ||
      property.shorthand === true ||
      property.optional === true
    ) {
      throw new Error(
        `${sourcePath} contains an unsupported accessor, method, or shorthand property.`,
      );
    }
    const name = propertyName(property.key);
    if (name === undefined) {
      throw new Error(`${sourcePath} contains an unsupported object property key.`);
    }
    if (name === "__proto__") {
      throw new Error(`${sourcePath} must not contain a non-computed __proto__ property.`);
    }
    if (names.has(name)) {
      throw new Error(`${sourcePath} contains a duplicate object property: ${name}.`);
    }
    names.add(name);
    properties.push({ name, property });
  }
  return properties;
}

function staticEnvironment(program, sourcePath, budget, defaultDeclaration) {
  const bindings = new Map();

  // Imports are module-scoped and initialized before any other module body
  // statement. Predeclare them before walking the statement order so a default
  // export can safely use an import written later in the file.
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      const moduleName = statement.source?.type === "Literal" ? statement.source.value : undefined;
      if (statement.importKind !== "type" && (statement.specifiers?.length ?? 0) === 0) {
        throw new Error(`${sourcePath} contains an unsupported runtime import.`);
      }
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.importKind === "type" || statement.importKind === "type") continue;
        const localName = specifier.local?.name;
        if (!localName) continue;
        if (bindings.has(localName)) {
          throw new Error(`${sourcePath} contains a duplicate runtime binding: ${localName}.`);
        }
        if (moduleName !== "@paperback/types") {
          throw new Error(`${sourcePath} contains an unsupported runtime import.`);
        }
        if (specifier.type === "ImportSpecifier") {
          const importedName = specifier.imported?.name ?? specifier.imported?.value;
          if (typeof importedName === "string" && Object.hasOwn(PAPERBACK_ENUMS, importedName)) {
            bindings.set(localName, { type: "enum", enumName: importedName });
          } else {
            throw new Error(`${sourcePath} contains an unsupported @paperback/types import.`);
          }
        } else if (specifier.type === "ImportNamespaceSpecifier") {
          bindings.set(localName, { type: "namespace" });
        } else {
          throw new Error(`${sourcePath} contains an unsupported @paperback/types import.`);
        }
      }
    } else if (
      statement.type !== "VariableDeclaration" &&
      statement.type !== "ExportDefaultDeclaration"
    ) {
      throw new Error(`${sourcePath} contains an unsupported top-level statement.`);
    }
  }

  // Lexical bindings exist throughout the module but remain in the temporal
  // dead zone until their declaration is reached. Predeclaring all constants
  // lets identifier evaluation distinguish a later binding from an unknown one.
  for (const statement of program.body) {
    if (statement.type !== "VariableDeclaration") continue;
    if (statement.kind !== "const") {
      throw new Error(`${sourcePath} contains an unsupported constant declaration.`);
    }
    for (const declaration of statement.declarations) {
      if (declaration.id?.type !== "Identifier" || !declaration.init) {
        throw new Error(`${sourcePath} contains an unsupported constant declaration.`);
      }
      if (bindings.has(declaration.id.name)) {
        throw new Error(
          `${sourcePath} contains a duplicate runtime binding: ${declaration.id.name}.`,
        );
      }
      bindings.set(declaration.id.name, {
        type: "const",
        expression: declaration.init,
        initialized: false,
      });
    }
  }

  let evaluatedDefault;
  for (const statement of program.body) {
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        const binding = bindings.get(declaration.id.name);
        evaluateStatic(declaration.init, bindings, sourcePath, new Set(), 0, budget);
        binding.initialized = true;
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      evaluatedDefault = evaluateStatic(
        defaultDeclaration,
        bindings,
        sourcePath,
        new Set(),
        0,
        budget,
      );
    }
  }
  return evaluatedDefault;
}

function marker(type, value) {
  return Object.freeze({ [STATIC_MARKER]: type, value });
}

function isMarker(value, type) {
  return value && typeof value === "object" && value[STATIC_MARKER] === type;
}

function unsupported(expression, sourcePath) {
  throw new Error(
    `${sourcePath} contains an unsupported or dynamic metadata expression (${expression?.type ?? "unknown"}).`,
  );
}

function memberName(member, sourcePath) {
  if (member.computed === true || member.optional === true) unsupported(member, sourcePath);
  const name = propertyName(member.property);
  if (name === undefined) unsupported(member, sourcePath);
  return name;
}

function evaluateStatic(expression, bindings, sourcePath, stack, depth, budget) {
  const current = unwrapExpression(expression);
  budget.visit(current, depth);

  if (current.type === "Literal") {
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean" ||
      (typeof current.value === "number" && Number.isFinite(current.value))
    ) {
      budget.scalar(current.value);
      return current.value;
    }
    unsupported(current, sourcePath);
  }

  if (current.type === "Identifier") {
    const binding = bindings.get(current.name);
    if (!binding) unsupported(current, sourcePath);
    if (binding.type === "enum" || binding.type === "namespace")
      return marker(binding.type, binding);
    if (binding.type !== "const") unsupported(current, sourcePath);
    if (!binding.initialized) unsupported(current, sourcePath);
    if (stack.has(current.name)) unsupported(current, sourcePath);
    const nextStack = new Set(stack);
    nextStack.add(current.name);
    return evaluateStatic(binding.expression, bindings, sourcePath, nextStack, depth + 1, budget);
  }

  if (current.type === "MemberExpression") {
    const object = evaluateStatic(current.object, bindings, sourcePath, stack, depth + 1, budget);
    const name = memberName(current, sourcePath);
    if (isMarker(object, "enum")) {
      if (!Object.hasOwn(PAPERBACK_ENUMS, object.value.enumName)) unsupported(current, sourcePath);
      const values = PAPERBACK_ENUMS[object.value.enumName];
      if (!Object.hasOwn(values, name)) unsupported(current, sourcePath);
      const value = values[name];
      budget.scalar(value);
      return value;
    }
    if (isMarker(object, "namespace")) {
      if (!Object.hasOwn(PAPERBACK_ENUMS, name)) unsupported(current, sourcePath);
      return marker("enum", { enumName: name });
    }
    if (object && typeof object === "object" && !Array.isArray(object)) {
      if (!Object.prototype.hasOwnProperty.call(object, name)) unsupported(current, sourcePath);
      return object[name];
    }
    unsupported(current, sourcePath);
  }

  if (current.type === "ArrayExpression") {
    budget.container(current.elements.length, "array");
    const values = [];
    for (const element of current.elements) {
      if (!element) unsupported(current, sourcePath);
      budget.arrayEntry();
      const value = evaluateStatic(element, bindings, sourcePath, stack, depth + 1, budget);
      if (isMarker(value, "enum") || isMarker(value, "namespace")) unsupported(element, sourcePath);
      values.push(value);
    }
    return values;
  }

  if (current.type === "ObjectExpression") {
    budget.container(current.properties.length, "object");
    const properties = staticObjectProperties(current, sourcePath);
    const object = {};
    for (const [index, { name, property }] of properties.entries()) {
      budget.objectKey(name, index);
      const value = evaluateStatic(property.value, bindings, sourcePath, stack, depth + 1, budget);
      if (isMarker(value, "enum") || isMarker(value, "namespace"))
        unsupported(property.value, sourcePath);
      Object.defineProperty(object, name, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
    return object;
  }

  if (
    current.type === "UnaryExpression" &&
    (current.operator === "+" || current.operator === "-")
  ) {
    const value = evaluateStatic(current.argument, bindings, sourcePath, stack, depth + 1, budget);
    if (typeof value !== "number") unsupported(current, sourcePath);
    return current.operator === "-" ? -value : value;
  }

  unsupported(current, sourcePath);
}

export function extractExtensionInfo(sourceText, sourcePath = "pbconfig.ts") {
  const program = parseProgram(sourceText, sourcePath);
  const declaration = defaultObject(program, sourcePath);
  const budget = new StaticEvaluationBudget(sourcePath);
  return staticEnvironment(program, sourcePath, budget, declaration);
}

export function extractVersion(sourceText, sourcePath = "pbconfig.ts") {
  const program = parseProgram(sourceText, sourcePath);
  const declaration = defaultObject(program, sourcePath);

  if (declaration.properties.some((property) => property.type === "SpreadElement")) {
    throw new Error(`${sourcePath} default export must not contain object spreads.`);
  }

  if (
    declaration.properties.some((property) => property.type === "Property" && property.computed)
  ) {
    throw new Error(`${sourcePath} default export must not contain computed properties.`);
  }

  if (
    declaration.properties.some(
      (property) => property.type === "Property" && propertyName(property.key) === "__proto__",
    )
  ) {
    throw new Error(`${sourcePath} must not contain a non-computed __proto__ property.`);
  }

  const versionProperties = declaration.properties.filter(
    (property) => property.type === "Property" && propertyName(property.key) === "version",
  );
  if (versionProperties.length !== 1) {
    throw new Error(`${sourcePath} must declare exactly one literal version property.`);
  }

  const versionProperty = versionProperties[0];
  if (
    versionProperty.kind !== "init" ||
    versionProperty.method === true ||
    versionProperty.shorthand === true
  ) {
    throw new Error(`${sourcePath} must declare exactly one plain version property.`);
  }

  const value = unwrapExpression(versionProperty.value);
  if (value?.type !== "Literal" || typeof value.value !== "string") {
    throw new Error(`${sourcePath} does not declare a literal version.`);
  }
  return value.value;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    current &&
    [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSNonNullExpression",
      "TSTypeAssertion",
    ].includes(current.type)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(key) {
  if (key?.type === "Identifier") return key.name;
  if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

export function parseSemver(version, sourcePath = "version") {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`${sourcePath} must be a valid semantic version: ${version}`);

  const prerelease = match[4]
    ? match[4].split(".").map((identifier) => {
        if (/^\d+$/.test(identifier) && !/^(0|[1-9]\d*)$/.test(identifier)) {
          throw new Error(`${sourcePath} must be a valid semantic version: ${version}`);
        }
        return /^\d+$/.test(identifier) ? BigInt(identifier) : identifier;
      })
    : [];

  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
  };
}

export function isValidSemver(version) {
  try {
    parseSemver(version);
    return true;
  } catch {
    return false;
  }
}

export function compareSemver(left, right) {
  const a = typeof left === "string" ? parseSemver(left) : left;
  const b = typeof right === "string" ? parseSemver(right) : right;

  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    if (typeof leftIdentifier === "bigint" && typeof rightIdentifier === "bigint") {
      return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    if (typeof leftIdentifier === "bigint") return -1;
    if (typeof rightIdentifier === "bigint") return 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }

  return 0;
}
