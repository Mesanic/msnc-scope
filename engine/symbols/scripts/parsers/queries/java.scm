; Scope symbol extraction query for Java.
;
; Capture conventions consumed by lib/extract.mjs:
;   *.def  - the full definition node (span source)
;   *.name - declared name
;   pk.* package clause, im.* import declarations,
;   cl.* call sites, ra.* Spring-style annotation routes (method level),
;   cra.* class-level RequestMapping prefix, loc.* local name bindings.
;   Annotations and Javadoc comments are read from the modifiers child /
;   preceding comment siblings by the extractor.

(package_declaration
  (scoped_identifier) @pk.name) @pk.def

(package_declaration
  (identifier) @pk0.name) @pk0.def

(import_declaration) @im.stmt

(class_declaration
  name: (identifier) @cls.name
  superclass: (superclass)? @cls.super
  interfaces: (super_interfaces)? @cls.ifaces) @cls.def

(interface_declaration
  name: (identifier) @iface.name
  (extends_interfaces)? @iface.ext) @iface.def

(enum_declaration
  name: (identifier) @enum.name
  interfaces: (super_interfaces)? @enum.ifaces) @enum.def

(record_declaration
  name: (identifier) @rec.name
  interfaces: (super_interfaces)? @rec.ifaces) @rec.def

(method_declaration
  name: (identifier) @m.name
  parameters: (formal_parameters)? @m.params) @m.def

(constructor_declaration
  name: (identifier) @ctor.name
  parameters: (formal_parameters)? @ctor.params) @ctor.def

(method_invocation
  name: (identifier) @cl.id)

(method_invocation
  object: (_) @cl.obj
  name: (identifier) @cl.prop)

(method_declaration
  (modifiers
    (annotation
      name: (identifier) @ra.name
      (annotation_argument_list)? @ra.args))
  (#match? @ra.name "^(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)$")) @ra.def

(method_declaration
  (modifiers
    (marker_annotation
      name: (identifier) @ra0.name))
  (#match? @ra0.name "^(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)$")) @ra0.def

(class_declaration
  (modifiers
    (annotation
      name: (identifier) @cra.name
      (annotation_argument_list)? @cra.args))
  (#match? @cra.name "^RequestMapping$")) @cra.def

(local_variable_declaration
  (variable_declarator
    name: (identifier) @loc.name))
