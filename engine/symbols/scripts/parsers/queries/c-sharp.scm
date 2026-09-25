; Scope symbol extraction query for C#.
;
; Capture conventions consumed by lib/extract.mjs:
;   *.def  - the full definition node (span source)
;   *.name - declared name
;   ns.*/fns.* namespace declarations, us.* using directives,
;   cl.*/nw.* call sites, ra.*/ra0.*/cra.* ASP.NET attribute routes,
;   loc.* local name bindings.
;   Attribute lists are also walked by the extractor for decorators/tests.

(using_directive) @us.stmt

(namespace_declaration
  name: (_) @ns.name) @ns.def

(file_scoped_namespace_declaration
  name: (_) @fns.name) @fns.def

(class_declaration
  name: (identifier) @cls.name
  (base_list)? @cls.bases) @cls.def

(interface_declaration
  name: (identifier) @iface.name
  (base_list)? @iface.bases) @iface.def

(struct_declaration
  name: (identifier) @st.name
  (base_list)? @st.bases) @st.def

(record_declaration
  name: (identifier) @rec.name
  (base_list)? @rec.bases) @rec.def

(enum_declaration
  name: (identifier) @enum.name) @enum.def

(method_declaration
  name: (identifier) @m.name
  parameters: (parameter_list)? @m.params) @m.def

(invocation_expression
  function: (identifier) @cl.id)

(invocation_expression
  function: (member_access_expression) @cl.mem)

(object_creation_expression
  type: [(identifier) (qualified_name)] @nw.t)

(method_declaration
  (attribute_list
    (attribute
      name: (identifier) @ra.name
      (attribute_argument_list
        .
        (attribute_argument
          (string_literal) @ra.path))))
  (#match? @ra.name "^(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|Route)$")) @ra.def

(method_declaration
  (attribute_list
    (attribute
      name: (identifier) @ra0.name))
  (#match? @ra0.name "^(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete)$")) @ra0.def

(class_declaration
  (attribute_list
    (attribute
      name: (identifier) @cra.name
      (attribute_argument_list
        .
        (attribute_argument
          (string_literal) @cra.path))))
  (#match? @cra.name "^(Route)$")) @cra.def

(local_declaration_statement
  (variable_declaration
    (variable_declarator
      name: (identifier) @loc.name)))
