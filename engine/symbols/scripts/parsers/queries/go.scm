; Scope symbol extraction query for Go.
;
; Capture conventions consumed by lib/extract.mjs:
;   *.def  - the full definition node (span source)
;   *.name - declared name
;   .params / .ret / .recv - signature fragments (parameters / result / receiver)
;   im.* imports, pkg.* package clause, cl.* call sites,
;   rt.* gin/chi-style route registrations, loc.* local name bindings.

(package_clause (package_identifier) @pkg.name) @pkg.def

(import_declaration
  (import_spec_list
    (import_spec
      path: (interpreted_string_literal) @im.path)) @im.list) @im.stmt

(import_declaration
  (import_spec
    path: (interpreted_string_literal) @im.path)) @im.stmt

(function_declaration
  name: (identifier) @fn.name
  parameters: (parameter_list)? @fn.params) @fn.def

(method_declaration
  receiver: (parameter_list) @m.recv
  name: (field_identifier) @m.name
  parameters: (parameter_list)? @m.params) @m.def

(type_declaration
  (type_spec
    name: (type_identifier) @cls.name
    type: (struct_type)) @cls.spec) @cls.def

(type_declaration
  (type_spec
    name: (type_identifier) @iface.name
    type: (interface_type)) @iface.spec) @iface.def

(call_expression
  function: (identifier) @cl.id)

(call_expression
  function: (selector_expression
    operand: (identifier) @cl.head
    field: (field_identifier) @cl.prop))

(call_expression
  function: (selector_expression
    operand: (selector_expression) @cl.chain))

(call_expression
  function: (selector_expression
    operand: (identifier) @rt.obj
    field: (field_identifier) @rt.method)
  arguments: (argument_list
    .
    (interpreted_string_literal) @rt.path)
  (#match? @rt.method "^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Get|Post|Put|Patch|Delete|Options|Head|Any)$")
  (#match? @rt.obj "^(r|router|routerGroup|engine|e|api|srv|mux|group|g|app)$"))

(var_declaration
  (var_spec
    name: (identifier) @loc.name))

(const_declaration
  (const_spec
    name: (identifier) @loc.name))

(short_var_declaration
  left: (expression_list
    (identifier) @loc.name))

(assignment_statement
  left: (expression_list
    (identifier) @loc.name))
