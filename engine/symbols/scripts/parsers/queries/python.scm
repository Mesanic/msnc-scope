; Scope symbol extraction query for Python.
;
; Capture conventions consumed by lib/extract.mjs:
;   *.def  - the full definition node (span source)
;   *.name - declared name
;   .params / .ret / .sc - signature fragments (parameters / return type / superclasses)
;   im.* plain imports, ifm.* from-imports, cl.* call sites,
;   rt.* framework route decorators, loc.* local name bindings.

(function_definition
  name: (identifier) @fn.name
  parameters: (parameters)? @fn.params
  return_type: (type)? @fn.ret) @fn.def

(class_definition
  name: (identifier) @cls.name
  superclasses: (argument_list)? @cls.sc) @cls.def

(import_statement) @im.stmt

(import_from_statement
  module_name: [
    (dotted_name) @ifm.mod
    (relative_import) @ifm.rel]) @ifm.stmt

(call
  function: (identifier) @cl.id)

(call
  function: (attribute) @cl.at)

(decorated_definition
  (decorator
    (call
      function: (attribute
        object: (identifier) @rt.obj
        attribute: (identifier) @rt.method)
      arguments: (argument_list (string (string_content) @rt.path)))
    (#match? @rt.method "^(route|get|post|put|patch|delete|options|head)$")
    (#match? @rt.obj "^(app|router|api|blueprint)$"))
  definition: (function_definition) @rt.def)

(assignment
  left: (identifier) @loc.name)
