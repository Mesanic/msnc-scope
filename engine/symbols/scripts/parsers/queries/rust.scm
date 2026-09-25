; Scope symbol extraction query for Rust.
;
; Capture conventions consumed by lib/extract.mjs:
;   *.def  - the full definition node (span source)
;   *.name - declared name
;   .params / .ret - signature fragments
;   im.* use declarations (paths/trees/wildcards/as-clauses),
;   cl.* call sites, rb.* builder-style route registrations.
;   Attributes (#[test], #[get("/x")], doc comments) are read from sibling
;   attribute_item nodes by the extractor, not captured here.

(function_item
  name: (identifier) @fn.name
  parameters: (parameters)? @fn.params) @fn.def

(function_signature_item
  name: (identifier) @fsig.name
  parameters: (parameters)? @fsig.params) @fsig.def

(struct_item
  name: (type_identifier) @st.name) @st.def

(enum_item
  name: (type_identifier) @en.name) @en.def

(union_item
  name: (type_identifier) @un.name) @un.def

(type_item
  name: (type_identifier) @ty.name) @ty.def

(trait_item
  name: (type_identifier) @tr.name) @tr.def

(mod_item
  name: (identifier) @md.name) @md.def

(impl_item
  trait: (_) @im.trait
  type: (_) @im.type) @im.def

(impl_item
  type: (_) @im2.type) @im2.def

(use_declaration
  argument: (scoped_identifier)) @im.stmt

(use_declaration
  argument: (scoped_use_list)) @im.stmt

(use_declaration
  argument: (use_list)) @im.stmt

(use_declaration
  argument: (use_wildcard)) @im.stmt

(use_declaration
  argument: (use_as_clause)) @im.stmt

(use_declaration
  argument: (identifier)) @im.stmt

(call_expression
  function: (identifier) @cl.id)

(call_expression
  function: (scoped_identifier) @cl.scoped)

(call_expression
  function: (field_expression) @cl.field)

(call_expression
  function: (field_expression
    field: (field_identifier) @rb.method)
  (#match? @rb.method "^(route|resource|service)$"))

(let_declaration
  pattern: (identifier) @loc.name)
