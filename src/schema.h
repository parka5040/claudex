/* Reduces a tool's JSON Schema to the subset the official Codex client sends upstream. */
#ifndef CLAUDEX_SCHEMA_H
#define CLAUDEX_SCHEMA_H

#include <yyjson.h>

/* Returns a sanitized deep copy of `schema` owned by `doc` (never NULL unless OOM).
 * Use schema_sanitize_root for a tool's top-level `parameters`. */
yyjson_mut_val *schema_sanitize(yyjson_mut_doc *doc, yyjson_val *schema);

/* As above, but guarantees an object schema: anything else becomes
 * {"type":"object","properties":{}}. */
yyjson_mut_val *schema_sanitize_root(yyjson_mut_doc *doc, yyjson_val *schema);

#endif
