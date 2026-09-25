; Scope symbol extraction query for TypeScript and TSX.
;
; The tsx registry entry shares this file: the tree-sitter-typescript grammar is a
; superset of JSX/TSX syntax, so keeping a single query source avoids drift between
; the two grammars (see parsers/languages.mjs).
;
; Capture conventions consumed by lib/extract.mjs:
;   *.def  - the full definition node (span source)
;   *.name - declared name
;   .params / .ret / .tp - signature fragments
;   im.* imports, rx.* re-exports, rq.* require calls,
;   cl.* / nw.* call sites, rt.* express-style route registrations.

(function_declaration
  name: (identifier) @fn.name
  parameters: (formal_parameters)? @fn.params
  return_type: (type_annotation)? @fn.ret) @fn.def

(generator_function_declaration
  name: (identifier) @gfn.name
  parameters: (formal_parameters)? @gfn.params) @gfn.def

(method_definition
  name: (property_identifier) @m.name
  parameters: (formal_parameters)? @m.params
  return_type: (type_annotation)? @m.ret) @m.def

(variable_declarator
  name: (identifier) @af.name
  value: (arrow_function
    parameters: (formal_parameters)? @af.params
    return_type: (type_annotation)? @af.ret)) @af.def

; CommonJS export assignments: exports.NAME = function f(…) {} / = (…) => {},
; including module.exports.NAME. The dominant export pattern in older Node code
; (express et al.) — without this capture those symbols are invisible to
; locate/impact. Generator function expressions are not captured (rare here).
(assignment_expression
  left: (member_expression
    object: (identifier) @xffn.obj
    property: (property_identifier) @xffn.name)
  right: (function_expression
    parameters: (formal_parameters)? @xffn.params) @xffn.def
  (#match? @xffn.obj "^(exports|module)$"))

(assignment_expression
  left: (member_expression
    object: (identifier) @xfar.obj
    property: (property_identifier) @xfar.name)
  right: (arrow_function
    parameters: (formal_parameters)? @xfar.params
    return_type: (type_annotation)? @xfar.ret) @xfar.def
  (#match? @xfar.obj "^(exports|module)$"))

(assignment_expression
  left: (member_expression
    object: (member_expression
      object: (identifier) @xffn.obj
      property: (property_identifier) @xffn.xp)
    property: (property_identifier) @xffn.name)
  right: (function_expression
    parameters: (formal_parameters)? @xffn.params) @xffn.def
  (#eq? @xffn.xp "exports")
  (#match? @xffn.obj "^(exports|module)$"))

(class_declaration
  name: (type_identifier) @cls.name
  type_parameters: (type_parameters)? @cls.tp
  (class_heritage)? @cls.h) @cls.def

(abstract_class_declaration
  name: (type_identifier) @acls.name
  type_parameters: (type_parameters)? @acls.tp
  (class_heritage)? @acls.h) @acls.def

(interface_declaration
  name: (type_identifier) @iface.name
  type_parameters: (type_parameters)? @iface.tp) @iface.def

(enum_declaration
  name: (identifier) @enum.name) @enum.def

(type_alias_declaration
  name: (type_identifier) @type.name
  type_parameters: (type_parameters)? @type.tp) @type.def

(import_statement
  source: (string (string_fragment) @im.src)) @im.stmt

(export_statement
  (string (string_fragment) @rx.src)) @rx.stmt

(variable_declarator
  value: (call_expression
    function: (identifier) @rq.fn
    arguments: (arguments (string (string_fragment) @rq.src)))) @rq.decl

; CommonJS member-access require: var X = require('./m').member; binds the
; required member as a named import under local name X.
(variable_declarator
  name: (identifier) @rq.mname
  value: (member_expression
    object: (call_expression
      function: (identifier) @rq.fn
      arguments: (arguments (string (string_fragment) @rq.src)))
    property: (property_identifier) @rq.prop)) @rq.decl

(expression_statement
  (call_expression
    function: (identifier) @rq2.fn
    arguments: (arguments (string (string_fragment) @rq2.src))))

(call_expression
  function: (identifier) @cl.id)

(call_expression
  function: (member_expression) @cl.mem)

(new_expression
  constructor: (identifier) @nw.id)

(new_expression
  constructor: (member_expression) @nw.mem)

(call_expression
  function: (member_expression
    object: (identifier) @rt.obj
    property: (property_identifier) @rt.method)
  arguments: (arguments (string (string_fragment) @rt.path))
  (#match? @rt.method "^(get|post|put|patch|delete|options|head|all|use)$")
  (#match? @rt.obj "^(app|router|server|api)$"))

(variable_declarator
  name: (identifier) @loc.name)
