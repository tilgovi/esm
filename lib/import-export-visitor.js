"use strict";

const assert = require("assert");
const MagicString = require("magic-string/dist/magic-string.cjs.js");
const utils = require("./utils.js");
const Visitor = require("./visitor.js");
const getOption = require("./options.js").get;

const hasOwn = Object.prototype.hasOwnProperty;

function ImportExportVisitor() {
  Visitor.call(this);
}

module.exports = ImportExportVisitor;

const IEVp = ImportExportVisitor.prototype =
  Object.create(Visitor.prototype);
IEVp.constructor = ImportExportVisitor;

IEVp.reset = function (rootPath, codeOrNull, options) {
  if (typeof codeOrNull === "string") {
    this.code = codeOrNull;
    this.magicString = new MagicString(codeOrNull);
  } else {
    this.code = this.magicString = null;
  }

  this.bodyInfos = [];
  this.removals = [];
  this.exportedLocalNames = Object.create(null);
  this.generateLetDeclarations =
    !! getOption(options, "generateLetDeclarations");
  this.modifyAST = !! getOption(options, "ast");
  this.parse = getOption(options, "parse");
  this.nextKey = 0;

  return this;
};

IEVp.makeUniqueKey = function () {
  return this.nextKey++;
};

IEVp.pad = function (newCode, oldStart, oldEnd) {
  if (this.code) {
    const oldLines = this.code.slice(oldStart, oldEnd).split("\n");
    const newLines = newCode.split("\n");
    let diff = oldLines.length - newLines.length;
    while (diff --> 0) {
      newLines.push("");
    }
    newCode = newLines.join("\n");
  }
  return newCode;
};

IEVp.overwrite = function (oldStart, oldEnd, newCode, trailing) {
  if (! this.code) {
    return this;
  }

  assert.strictEqual(typeof oldStart, "number");
  assert.strictEqual(typeof oldEnd, "number");
  assert.strictEqual(typeof newCode, "string");

  const padded = this.pad(newCode, oldStart, oldEnd);

  if (oldStart === oldEnd) {
    if (padded === "") {
      return this;
    }

    if (trailing) {
      this.magicString.appendLeft(oldStart, padded);
    } else {
      this.magicString.prependRight(oldStart, padded);
    }

  } else {
    this.magicString.overwrite(oldStart, oldEnd, padded);
  }

  return this;
};

IEVp.getBlockBodyInfo = function (path) {
  const node = path.getNode();
  const parent = path.getParentNode();

  let insertCharIndex = node.start;
  let bodyName = "body";
  let body;

  switch (parent.type) {
  case "Program":
    body = parent.body;
    insertCharIndex = parent.start;
    break;

  case "BlockStatement":
    body = parent.body;

    if (hasOwn.call(parent, "start")) {
      insertCharIndex = parent.start + 1;
    } else {
      insertCharIndex = body[0].start;
    }

    break;

  case "SwitchCase":
    bodyName = "consequent";
    body = parent.consequent;
    insertCharIndex = body[0].start;
    break;

  default:
    bodyName = path.getName();

    const block = {
      type: "BlockStatement",
      body: []
    };

    body = block.body;

    insertCharIndex = node.start;

    if (this.magicString) {
      this.magicString
        .appendLeft(insertCharIndex, "{")
        .prependRight(node.end, "}");
    }

    path.replace(block);
  }

  assert.ok(Array.isArray(body), body);

  // Avoid hoisting above string literal expression statements such as
  // "use strict", which may depend on occurring at the beginning of
  // their enclosing scopes.
  let insertNodeIndex = 0;
  const stmtCount = body.length;

  for (let i = 0; i < stmtCount; ++i) {
    const stmt = body[i];
    if (stmt.type === "ExpressionStatement") {
      const expr = stmt.expression;
      if (expr.type === "StringLiteral" ||
          (expr.type === "Literal" &&
           typeof expr.value === "string")) {
        insertCharIndex = stmt.end;
        insertNodeIndex = i + 1;
        continue;
      }
    }
    break;
  }

  // Babylon represents directives like "use strict" with a .directives
  // array property on the parent node.
  const directives = parent.directives;
  if (directives) {
    const directiveCount = directives.length;

    for (let i = 0; i < directiveCount; ++i) {
      insertCharIndex = Math.max(directives[i].end, insertCharIndex);
    }
  }

  const bibn = parent._bodyInfoByName =
    parent._bodyInfoByName || Object.create(null);

  let bodyInfo = bibn[bodyName];
  if (bodyInfo) {
    assert.strictEqual(bodyInfo.body, body);

  } else {
    bodyInfo = bibn[bodyName] = Object.create(null);

    bodyInfo.body = body;
    bodyInfo.insertCharIndex = insertCharIndex;
    bodyInfo.insertNodeIndex = insertNodeIndex;
    bodyInfo.hoistedExportsMap = Object.create(null);
    bodyInfo.hoistedExportsString = "";
    bodyInfo.hoistedImportsString = "";

    this.bodyInfos.push(bodyInfo);
  }

  return bodyInfo;
};

IEVp.hoistExports = function (exportDeclPath, mapOrString, childName) {
  this.preserveChild(exportDeclPath, childName);
  const bodyInfo = this.getBlockBodyInfo(exportDeclPath);

  if (typeof mapOrString !== "string") {
    const keys = Object.keys(mapOrString);
    const keyCount = keys.length;

    for (let i = 0; i < keyCount; ++i) {
      const exported = keys[i];
      const locals = mapOrString[exported];
      const localCount = locals.length;

      for (let j = 0; j < localCount; ++j) {
        addToSpecifierMap(
          bodyInfo.hoistedExportsMap,
          exported,
          locals[j]
        );
      }
    }

  } else {
    bodyInfo.hoistedExportsString += mapOrString;
  }

  return this;
};

IEVp.hoistImports = function (importDeclPath, hoistedCode, childName) {
  this.preserveChild(importDeclPath, childName);
  const bodyInfo = this.getBlockBodyInfo(importDeclPath);
  bodyInfo.hoistedImportsString += hoistedCode;
  return this;
};

IEVp.preserveChild = function (path, childName) {
  const value = path.getValue();

  if (childName) {
    const child = value ? value[childName] : null;

    if (child && this.code) {
      this.overwrite(
        value.start,
        child.start,
        ""
      ).overwrite(
        child.end,
        value.end,
        ""
      );
    }

    if (this.modifyAST) {
      // Replace the given path with the child we want to preserve.
      path.replace(child);
    }

    path.call(this.visitWithoutReset, childName);

  } else {
    if (this.code) {
      this.overwrite(value.start, value.end, "");
    }

    if (this.modifyAST) {
      this.removals.push({
        container: path.getContainer(),
        name: path.getName(),
        value: value
      });
    }
  }

  return this;
};

IEVp.finalizeHoisting = function () {
  const infoCount = this.bodyInfos.length;

  for (let i = 0; i < infoCount; ++i) {
    const bodyInfo = this.bodyInfos[i];
    const parts = [];

    const namedExports = toModuleExport(bodyInfo.hoistedExportsMap);
    if (namedExports) {
      parts.push(namedExports);
    }

    if (bodyInfo.hoistedExportsString) {
      parts.push(bodyInfo.hoistedExportsString);
    }

    if (bodyInfo.hoistedImportsString) {
      parts.push(bodyInfo.hoistedImportsString);
    }

    if (parts.length) {
      const codeToInsert = parts.join("");

      if (this.magicString) {
        this.magicString.prependRight(
          bodyInfo.insertCharIndex,
          codeToInsert
        );
      }

      if (this.modifyAST) {
        let ast = this.parse(codeToInsert);
        if (ast.type === "File") ast = ast.program;
        assert.strictEqual(ast.type, "Program");
        const spliceArgs = ast.body;
        spliceArgs.unshift(bodyInfo.insertNodeIndex, 0);
        const body = bodyInfo.body;
        body.splice.apply(body, spliceArgs);
      }
    }

    delete bodyInfo.body;
    delete bodyInfo.insertCharIndex;
    delete bodyInfo.insertNodeIndex;
    delete bodyInfo.hoistedExportsMap;
    delete bodyInfo.hoistedExportsString;
    delete bodyInfo.hoistedImportsString;
  }

  // Just in case we call finalizeHoisting again, don't hoist anything.
  this.bodyInfos.length = 0;

  this.removals.forEach(processRemoval);

  // Just in case we call finalizeHoisting again, don't remove anything.
  this.removals.length = 0;
};

function processRemoval(removal) {
  if (Array.isArray(removal.container)) {
    const index = removal.container.indexOf(removal.value);
    if (index >= 0) {
      removal.container.splice(index, 1);
    }
  } else if (removal.value ===
             removal.container[removal.name]) {
    // This case is almost certainly never reached.
    removal.container[removal.name] = null;
  } else {
    const newValue = removal.container[removal.name];
    if (newValue.type === "BlockStatement") {
      // This newValue is a BlockStatement that we created in the default
      // case of the switch statement in getBlockBodyInfo, so we make sure
      // the original import/export declaration is no longer in its .body.
      processRemoval({
        container: newValue.body,
        value: removal.value
      });
    }
  }
}

IEVp.visitImportDeclaration = function (path) {
  const decl = path.getValue();
  const specifierCount = decl.specifiers.length;
  const parts = [];

  if (specifierCount) {
    const identifiers = [];
    const namespaces = [];

    for (let i = 0; i < specifierCount; ++i) {
      const s = decl.specifiers[i];
      const name = s.local.name;

      if (s.type === "ImportNamespaceSpecifier") {
        namespaces.push(name);
      } else {
        identifiers.push(name);
      }
    }

    const identifierCount = identifiers.length;
    if (identifierCount) {
      const lastIndex = identifierCount - 1;
      parts.push(this.generateLetDeclarations ? "let " : "var ");

      for (let i = 0; i < identifierCount; ++i) {
        const isLast = i === lastIndex;
        parts.push(
          identifiers[i],
          isLast ? ";" : ","
        );
      }
    }

    const namespaceCount = namespaces.length;
    if (namespaceCount) {
      const lastIndex = namespaceCount - 1;
      parts.push(this.generateLetDeclarations ? "const " : "var ");

      for (let i = 0; i < namespaceCount; ++i) {
        const isLast = i === lastIndex;
        parts.push(
          namespaces[i],
          "=Object.create(null)",
          isLast ? ";" : ","
        );
      }
    }
  }

  parts.push(toModuleImport(
    this._getSourceString(decl),
    computeSpecifierMap(decl.specifiers),
    this.makeUniqueKey()
  ));

  this.hoistImports(path, parts.join(""));

  return false;
};

IEVp.visitExportAllDeclaration = function (path) {
  const decl = path.getValue();
  const parts = [
    this.pad("module.importSync(", decl.start, decl.source.start),
    this._getSourceString(decl),
    this.pad(
      ",{'*':(v,k)=>{exports[k]=v;}}," +
        this.makeUniqueKey() + ");",
      decl.source.end,
      decl.end
    )
  ];

  this.hoistExports(path, parts.join(""));

  return false;
};

IEVp.visitExportDefaultDeclaration = function (path) {
  const decl = path.getValue();
  const dd = decl.declaration;

  if (dd.id && (dd.type === "FunctionDeclaration" ||
                dd.type === "ClassDeclaration")) {
    // If the exported default value is a function or class declaration,
    // it's important that the declaration be visible to the rest of the
    // code in the exporting module, so we must avoid compiling it to a
    // named function or class expression.
    this.hoistExports(path, {
      "default": [dd.id.name]
    }, "declaration");

  } else {
    // Otherwise, since the exported value is an expression, it's
    // important that we wrap it with parentheses, in case it's something
    // like a comma-separated sequence expression.
    this.overwrite(decl.start, dd.start, exportDefaultPrefix);

    path.call(this.visitWithoutReset, "declaration");
    assert.strictEqual(decl.declaration, dd);

    this.overwrite(dd.end, decl.end, exportDefaultSuffix, true);

    if (this.modifyAST) {
      // A Function or Class declaration has become an expression on the
      // right side of the _exportDefaultPrefix assignment above so change
      // the AST appropriately
      if (dd.type === "FunctionDeclaration") {
        dd.type = "FunctionExpression";
      } else if (dd.type === "ClassDeclaration") {
        dd.type = "ClassExpression";
      }

      path.replace(this._buildExportDefaultStatement(dd));
    }
  }
};

const exportDefaultPrefix =
  'module.export("default",exports.default=(';

const exportDefaultSuffix = "));";

IEVp._buildExportDefaultStatement = function (declaration) {
  let ast = this.parse(
    exportDefaultPrefix + "VALUE" + exportDefaultSuffix);

  if (ast.type === "File") {
    ast = ast.program;
  }

  assert.strictEqual(ast.type, "Program");

  const stmt = ast.body[0];
  assert.strictEqual(stmt.type, "ExpressionStatement");
  assert.strictEqual(stmt.expression.type, "CallExpression");

  const arg1 = stmt.expression.arguments[1];
  assert.strictEqual(arg1.right.type, "Identifier");
  assert.strictEqual(arg1.right.name, "VALUE");

  // Replace the VALUE identifier with the desired declaration.
  arg1.right = declaration;

  return stmt;
};

IEVp.visitExportNamedDeclaration = function (path) {
  const decl = path.getValue();
  const dd = decl.declaration;

  if (dd) {
    const specifierMap = Object.create(null);
    const addNameToMap = function (name) {
      addToSpecifierMap(specifierMap, name, name);
    };

    if (dd.id && (dd.type === "ClassDeclaration" ||
                  dd.type === "FunctionDeclaration")) {
      addNameToMap(dd.id.name);
    } else if (dd.type === "VariableDeclaration") {
      const ddCount = dd.declarations.length;

      for (let i = 0; i < ddCount; ++i) {
        const names = utils.getNamesFromPattern(dd.declarations[i].id);
        const nameCount = names.length;

        for (let j = 0; j < nameCount; ++j) {
          addNameToMap(names[j]);
        }
      }
    }

    this.hoistExports(path, specifierMap, "declaration");
    this.addExportedLocalNames(specifierMap);

    return;
  }

  if (decl.specifiers) {
    let specifierMap = computeSpecifierMap(decl.specifiers);

    if (decl.source) {
      if (specifierMap) {
        const newMap = Object.create(null);
        const keys = Object.keys(specifierMap);
        const keyCount = keys.length;

        for (let i = 0; i < keyCount; ++i) {
          const exported = keys[i];
          const locals = specifierMap[exported];
          const localCount = locals.length;

          for (let j = 0; j < localCount; ++j) {
            addToSpecifierMap(newMap, locals[j], "exports." + exported);
          }
        }

        specifierMap = newMap;
      }

      // Even though the compiled code uses module.importSync, it should
      // still be hoisted as an export, i.e. before actual imports.
      this.hoistExports(path, toModuleImport(
        this._getSourceString(decl),
        specifierMap,
        this.makeUniqueKey()
      ));

    } else {
      this.hoistExports(path, specifierMap);
      this.addExportedLocalNames(specifierMap);
    }
  }

  return false;
};

// Gets a string representation (including quotes) from an import or
// export declaration node.
IEVp._getSourceString = function (decl) {
  if (this.code) {
    return this.code.slice(
      decl.source.start,
      decl.source.end
    );
  }

  assert.strictEqual(typeof decl.source.value, "string");

  return JSON.stringify(decl.source.value);
};

IEVp.addExportedLocalNames = function (specifierMap) {
  if (specifierMap) {
    const exportedLocalNames = this.exportedLocalNames;
    const keys = Object.keys(specifierMap);
    const keyCount = keys.length;

    for (let i = 0; i < keyCount; ++i) {
      const exported = keys[i];
      const locals = specifierMap[exported];
      const localCount = locals.length;

      for (let j = 0; j < localCount; ++j) {
        // It's tempting to record the exported name as the value here,
        // instead of true, but there can be more than one exported name
        // per local variable, and we don't actually use the exported
        // name(s) in the assignmentVisitor, so it's not worth the added
        // complexity of tracking unused information.
        exportedLocalNames[locals[j]] = true;
      }
    }
  }
};

// Returns a map from {im,ex}ported identifiers to lists of local variable
// names bound to those identifiers.
function computeSpecifierMap(specifiers) {
  let specifierMap;
  const specifierCount = specifiers.length;

  for (let i = 0; i < specifierCount; ++i) {
    const s = specifiers[i];

    const local =
      s.type === "ExportDefaultSpecifier" ? "default" :
      s.type === "ExportNamespaceSpecifier" ? "*" :
      s.local.name;

    const __ported = // The IMported or EXported name.
      s.type === "ImportSpecifier" ? s.imported.name :
      s.type === "ImportDefaultSpecifier" ? "default" :
      s.type === "ImportNamespaceSpecifier" ? "*" :
      (s.type === "ExportSpecifier" ||
       s.type === "ExportDefaultSpecifier" ||
       s.type === "ExportNamespaceSpecifier") ? s.exported.name :
      null;

    if (typeof local !== "string" ||
        typeof __ported !== "string") {
      return;
    }

    specifierMap = addToSpecifierMap(
      specifierMap || Object.create(null),
      __ported,
      local
    );
  }

  return specifierMap;
}

function addToSpecifierMap(map, __ported, local) {
  assert.strictEqual(typeof __ported, "string");
  assert.strictEqual(typeof local, "string");

  const locals = map[__ported] || [];

  if (locals.indexOf(local) < 0) {
    locals.push(local);
  }

  map[__ported] = locals;

  return map;
}

function toModuleImport(source, specifierMap, uniqueKey) {
  const parts = ["module.importSync(", source];
  const importedNames = specifierMap ? Object.keys(specifierMap) : null;
  const nameCount = importedNames ? importedNames.length : 0;

  if (nameCount === 0) {
    parts.push(");");
    return parts.join("");
  }

  parts.push(",{");

  const lastIndex = nameCount - 1;

  for (let i = 0; i < nameCount; ++i) {
    const imported = importedNames[i];
    const isLast = i === lastIndex;
    const locals = specifierMap[imported];
    const valueParam = safeParam("v", locals);

    parts.push(
      JSON.stringify(imported),
      ":(", valueParam
    );

    if (imported === "*") {
      // There can be only one namespace import/export specifier.
      assert.strictEqual(locals.length, 1);
      const local = locals[0];

      if (local.startsWith("exports.")) {
        parts.unshift(`${local}=Object.create(null);`);
      }
      // When the imported name is "*", the setter function may be called
      // multiple times, and receives an additional parameter specifying
      // the name of the property to be set.
      const nameParam = safeParam("n", [local, valueParam]);

      parts.push(
        ",", nameParam, ")=>{",
        // The local variable should have been initialized as an empty
        // object when the variable was declared.
        local, "[", nameParam, "]=", valueParam
      );

    } else {
      // Multiple local variables become a compound assignment.
      parts.push(")=>{", locals.join("="), "=", valueParam);
    }

    parts.push("}");

    if (! isLast) {
      parts.push(",");
    }
  }

  parts.push("}," + uniqueKey + ");");

  return parts.join("");
}

function safeParam(param, locals) {
  if (locals.indexOf(param) < 0) {
    return param;
  }
  return safeParam("_" + param, locals);
}

function toModuleExport(specifierMap) {
  const exportedKeys = specifierMap ? Object.keys(specifierMap) : null;
  const keyCount = exportedKeys ? exportedKeys.length : 0;

  if (keyCount === 0) {
    return "";
  }

  const parts = ["module.export({"];
  const lastIndex = keyCount - 1;

  for (let i = 0; i < keyCount; ++i) {
    const exported = exportedKeys[i];
    const isLast = i === lastIndex;
    const locals = specifierMap[exported];

    assert.strictEqual(locals.length, 1);

    parts.push(
      exported,
      ":()=>",
      locals[0],
      isLast ? "" : ","
    );
  }

  parts.push("});");

  return parts.join("");
}