# PROTOCOL.md — ChatGPT-auth Codex Responses backend, as spoken by openai/codex

Reference for the claudex proxy (Anthropic Messages -> OpenAI Responses on the ChatGPT Codex backend).
Everything here was read from source; nothing was sent to the network.

- Primary source: `openai/codex` @ `595cc91e8cbb1c2ca822d0311dcf12709410c582` (main, 2026-09-19, "Avoid fork when spawning macOS filesystem helpers (#46661)"). Paths below are relative to `codex-rs/`.
- Secondary (cross-check only, no code copied): `raine/claude-code-proxy` @ `84434db444e5bb6b9a7ec577dd74a7e735f9b27d`, paths prefixed `ccp:`.
- `INFERRED` = not stated by source, deduced. `CCP-OBSERVED` = a claim made in claude-code-proxy comments/tests about live backend behaviour (not verifiable from openai/codex source).

---

## 1. Endpoint and transport

| Mode | Base URL | Full URL | Source |
|---|---|---|---|
| ChatGPT auth (`AuthMode::Chatgpt`, `ChatgptAuthTokens`, `Headers`, `AgentIdentity`, `PersonalAccessToken`) | `https://chatgpt.com/backend-api/codex` | `POST https://chatgpt.com/backend-api/codex/responses` | `model-provider-info/src/lib.rs` `CHATGPT_CODEX_BASE_URL`, `ModelProviderInfo::to_api_provider` |
| API key | `https://api.openai.com/v1` | `POST https://api.openai.com/v1/responses` | same fn, `else` branch |

- Path is always `"/responses"`, method `POST`: `codex-api/src/endpoint/responses.rs` `ResponsesClient::stream_encoded` (`Method::POST, "/responses"`).
- Only wire API left is Responses: `model-provider-info/src/lib.rs` `enum WireApi { Responses }` (`wire_api = "chat"` is a hard error).
- Other backend routes on the same base (not needed by us): `/models?client_version=…` (`model-provider/src/models_endpoint.rs`), `/memories/trace_summarize`, `/realtime/calls` (`core/src/client.rs` consts).

### SSE vs WebSocket
- Transport selection: `core/src/client.rs` `ModelClientSession::stream`. If `responses_websocket_enabled()` (provider `supports_websockets` = true for the built-in OpenAI provider, and session flag `disable_websockets` not set) it tries WebSocket first; otherwise, or on `WebsocketStreamOutcome::FallbackToHttp`, it calls `stream_responses_api` (HTTPS + SSE).
- WebSocket URL = same URL with `https`->`wss` (`codex-api/src/provider.rs` `websocket_url_for_path`), handshake header `OpenAI-Beta: responses_websockets=2026-02-06` (`RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE`), request frame `{"type":"response.create", …same body…, "previous_response_id"?, "generate"?}` (`codex-api/src/common.rs` `ResponsesWsRequest`, `ResponseCreateWsRequest`). Only the WS path ever sends `previous_response_id` (incremental input delta).
- HTTPS+SSE is still a first-class, model-agnostic path: `ModelClient::force_http_fallback(&self, _, _model_info)` ignores the model; after the WS retry budget is exhausted every later request in the session goes over HTTP (`try_switch_fallback_transport`). The lite header logic is wired into the HTTP option builder (`build_responses_options` -> `add_responses_lite_header`), so the client itself expects HTTP+SSE to work for lite models too. `models.json` carries a `prefer_websockets` key but `ModelInfo` has no such field (ignored by this client).
- SSE request: `Accept: text/event-stream`, JSON body, optional `Content-Encoding: zstd` (feature `enable_request_compression`, Stable, default on, only when auth uses the Codex backend: `ModelClientSession::responses_request_compression`). Compression is optional; plain JSON is what every test server receives when the flag is off. INFERRED: uncompressed bodies are accepted (ccp sends uncompressed).

### "Responses Lite" lane
- Trigger: per-model catalog flag `ModelInfo.use_responses_lite` (`protocol/src/openai_models.rs`). Nothing else (no config knob) turns it on.
- Bundled catalog `models-manager/models.json`: `use_responses_lite: true` AND `tool_mode: "code_mode_only"` for `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-daybreak-*`, `codex-auto-review`. `false`/null for `gpt-5.5`, `gpt-5.4`.
- What the client changes when lite is on (`core/src/client.rs` `build_responses_request`, `build_reasoning`, `add_responses_lite_header`, `build_ws_client_metadata`):
  - HTTP header `x-openai-internal-codex-responses-lite: true` (WS: `client_metadata["ws_request_header_x_openai_internal_codex_responses_lite"]="true"`). **Internal header — we do not send it.**
  - `instructions` omitted (empty string is skipped) and `tools` omitted; instead two items are spliced at the front of `input`: `{"type":"additional_tools","id":"at_<uuidv5>","role":"developer","tools":[…]}` and a `developer` message holding the base instructions (`core/src/context/base_instructions.rs` `BaseInstructionsFragment`, role `developer`).
  - tools are regrouped under a `{"type":"namespace","name":"functions",…}` wrapper (`tools/src/tool_spec.rs` `create_tools_json_for_responses_lite`).
  - `parallel_tool_calls` forced `false`; `reasoning.context = "all_turns"` (otherwise omitted; comment: "omit context so Responses uses the default, which is currently `current_turn`").
  - no hosted tools: `core/src/tools/spec_plan.rs` `hosted_model_tool_specs`: "Responses Lite accepts schemas for client-executed tools, not hosted Responses tools."
  - image `detail` stripped (`core/src/client_common.rs` `normalize_image_detail`).
- Does the normal lane work for these models?
  - Source evidence that the *models* run on a plain Responses lane: the Bedrock catalog reuses the same bundled entries and sets `model.use_responses_lite = false; model.tool_mode = None;` (`model-provider/src/amazon_bedrock/catalog.rs` `bedrock_model`) for `openai.gpt-5.6-sol`, `openai.gpt-6-astra`, `…terra`, `…luna`. That is a different server (Bedrock Mantle), so it says nothing certain about chatgpt.com.
  - CCP-OBSERVED (`ccp:src/providers/codex/translate/model_allowlist.rs` `uses_responses_lite`, `full_lane_web_search_model`): "`gpt-5.6-luna` exists only behind the Responses Lite lane; the full Responses API resolves it to a `-free` variant and returns 404"; hosted `web_search` requests are moved to the full lane and luna is upgraded to `gpt-5.6-sol` there — i.e. sol/terra/astra are reported to work on the normal lane, luna not.
  - CCP uses originator/User-Agent `codex_cli_rs` whenever it uses the lite lane (`ccp:src/providers/codex/client.rs` `build_codex_headers`, `auth/constants.rs` `RESPONSES_LITE_ORIGINATOR`). INFERRED: the lite lane may be gated on a first-party originator. We must not do that; see Open questions.

---

## 2. Request headers (ChatGPT-auth mode, HTTP+SSE path)

| Header | Value / derivation | Source | Class |
|---|---|---|---|
| `Authorization` | `Bearer <tokens.access_token>` | `model-provider/src/bearer_auth_provider.rs` `BearerAuthProvider::add_auth_headers`; token from `login/src/auth/manager.rs` `CodexAuth::get_token` | REQUIRED |
| `ChatGPT-Account-ID` | `tokens.account_id` (HTTP headers are case-insensitive; ccp spells it `ChatGPT-Account-Id`) | same fn; `CodexAuth::get_account_id` | REQUIRED in practice (INFERRED: selects workspace/plan; client always sends when known, omitted only when `None`) |
| `X-OpenAI-Fedramp: true` | only if id_token claim `chatgpt_account_is_fedramp` | same fn | routing, n/a for consumer accounts |
| `Accept` | `text/event-stream` | `codex-api/src/endpoint/responses.rs` `stream_encoded` | functional |
| `Content-Type` | `application/json` (inserted when absent for JSON bodies) | `http-client/src/route_aware_client_pool.rs` (~L267) | functional |
| `Content-Encoding` | `zstd` (level 3) when compression on | `core/src/client.rs` `responses_request_compression`; `http-client/src/request.rs` (~L197-217) | optional |
| `originator` | default `codex_cli_rs`; overridable (`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`, `set_default_originator`) | `login/src/auth/default_client.rs` `DEFAULT_ORIGINATOR`, `default_headers`, `add_originator_header` | identity. First-party values recognised client-side: `codex_cli_rs`, `codex-tui`, `codex_vscode`, `Codex *` (`is_first_party_originator`). We send `claude-code`. |
| `User-Agent` | `{originator}/{version} ({os} {os_version}; {arch}) {terminal_ua}[ (suffix)]` | `get_codex_user_agent` | identity. We send our own. |
| `version` | `CARGO_PKG_VERSION` of the CLI | `model-provider-info/src/lib.rs` `create_openai_provider` `http_headers` | identity/telemetry. Omit (we are not the CLI). |
| `OpenAI-Organization`, `OpenAI-Project` | from env `OPENAI_ORGANIZATION` / `OPENAI_PROJECT` if set | same, `env_http_headers` | API-key use; omit |
| `session-id` | normally = `prompt_cache_key` (= session id); comment: "ChatGPT derives cache affinity from the Responses session-id header" | `core/src/client.rs` `responses_session_id`; `codex-api/src/requests/headers.rs` `build_session_headers` | cache affinity. Safe and useful to send honestly (stable UUID per Claude Code session). Note: hyphenated `session-id` at this commit (older clients used `session_id`). |
| `thread-id` | thread UUID | `build_session_headers` | telemetry/affinity; optional |
| `x-client-request-id` | thread id | `ResponsesClient::stream_request` | telemetry; optional |
| `x-codex-window-id` | `window_id` | `core/src/responses_metadata.rs` `compatibility_headers` | telemetry; omit |
| `x-codex-turn-metadata` | ASCII JSON blob (session/thread/turn ids, sandbox, git workspace info, …) | `compatibility_headers`, `CodexTurnMetadataPayload` | telemetry; omit |
| `x-codex-parent-thread-id`, `x-openai-subagent` | sub-agent sessions only | `compatibility_headers`, `subagent_header` | telemetry; omit |
| `x-codex-installation-id` | only inside `client_metadata` on HTTP | `client_metadata()` | telemetry; omit |
| `x-codex-beta-features` | comma list of enabled beta feature keys | `build_responses_headers` | feature gating; omit |
| `x-codex-turn-state` | echo of the response header of the same name received earlier in the turn ("sticky routing token") | `build_responses_headers`; captured in `codex-api/src/sse/responses.rs` `spawn_response_stream` | routing optimisation. Optional; opaque server-issued value, fine to echo within one turn, fine to omit. |
| `x-codex-routing-hint` | `model=<slug>[;tier=<tier>]`, only when auth uses Codex backend | `build_routing_hint_header` | routing hint; omit |
| `x-openai-internal-codex-responses-lite` | `true` for lite models | `add_responses_lite_header` | INTERNAL — do not send |
| `x-oai-attestation` | device attestation if an `AttestationProvider` is configured (`include_attestation`) | `generate_attestation_header_for` | not available to us; omit |
| `x-openai-memgen-request`, `x-responsesapi-include-timing-metrics`, `x-codex-guardian` | special internal flows | `core/src/client.rs` consts | omit |
| `OpenAI-Beta` | **not sent on the HTTP path** at this commit; only `responses_websockets=2026-02-06` on the WS handshake | grep: `OPENAI_BETA_HEADER` used only in `build_websocket_headers` (+ `cli/src/doctor.rs`) | omit. (ccp still sends legacy `OpenAI-Beta: responses=experimental`; not needed per official client.) |

Minimal functional set per source: `Authorization`, `ChatGPT-Account-ID`, `Accept`, `Content-Type`. Everything else is identity/telemetry/routing.

Response headers the client reads (`codex-api/src/sse/responses.rs` `spawn_response_stream`): `x-codex-*` rate limits (section 8), `X-Models-Etag`, `OpenAI-Model` (actual serving model; may differ under safety routing), `x-reasoning-included` (presence => server already counted past reasoning tokens), `x-request-id`, `x-codex-turn-state`.

---

## 3. Request body schema

`codex-api/src/common.rs` `struct ResponsesApiRequest` (exact serialization order):

| Field | Type | Sent | Value the official client uses | Source |
|---|---|---|---|---|
| `model` | string | always | `model_info.slug` | `build_responses_request` |
| `instructions` | string | skipped if empty | base instructions (non-lite); empty => omitted (lite) | `#[serde(skip_serializing_if = "String::is_empty")]` |
| `input` | array of items | always | section 5 | |
| `tools` | array (raw JSON) | skipped if `None` | always `Some([...])` on normal lane (may be `[]`); `None` on lite | |
| `tool_choice` | string | always | always `"auto"` (client never sends object form) | |
| `parallel_tool_calls` | bool | always | `prompt.parallel_tool_calls && !use_responses_lite`; regular turns set `true` (`core/src/session/turn.rs:1567`) | |
| `reasoning` | object or `null` | always (no skip attr; client always passes `Some`) | `{effort?, summary?, context?}` | `build_reasoning` |
| `store` | bool | always | `false` | |
| `stream` | bool | always | `true` | |
| `stream_options` | object | optional | `{"reasoning_summary_delivery":"sequential_cutoff"}` only with feature `concurrent_reasoning_summaries` + summary on | |
| `include` | string[] | always | `["reasoning.encrypted_content"]` | |
| `service_tier` | string | optional | only if model lists the tier (`ModelInfo::service_tier_for_request`); catalog tiers: `priority` (all), `ultrafast` (sol). Value `default` is never sent. | |
| `prompt_cache_key` | string | optional, client always sets | session id (or override / `"{source}:{parent_thread_id}"`) | `ModelClient::prompt_cache_key` |
| `text` | object | optional | `{verbosity?: "low"\|"medium"\|"high", format?: {type:"json_schema", strict, schema, name:"codex_output_schema"}}`; verbosity only if `model_info.support_verbosity` (catalog default `low` for all current models) | `create_text_param_for_request`, `TextControls` |
| `client_metadata` | map<string,string> | optional, client always sets | `x-codex-installation-id`, `session_id`, `thread_id`, `x-codex-window-id`, `turn_id`, `x-codex-turn-metadata`… | `CodexResponsesMetadata::client_metadata` — telemetry; omit |
| `access_programs` | `{cyber: "standard"\|"daybreak_blue"\|"daybreak_red"}` | optional | trusted-access program; omit | `AccessPrograms` |

**Not in the struct, therefore never sent by the official client:** `max_output_tokens`, `temperature`, `top_p`, `metadata`, `user`, `truncation`, `previous_response_id` (HTTP), `background`, `safety_identifier`. ccp also deliberately drops Anthropic `max_tokens` (`ccp:…/translate/request.rs` test `max_tokens_is_not_serialized_for_codex`). INFERRED: treat these as unsupported on this backend; do not send.

`reasoning` (`struct Reasoning`): `effort` (skip if none) = requested effort or `model_info.default_reasoning_level`, passed through `resolve_reasoning_effort`; `summary` (skip if none) = `auto|concise|detailed`, sent only if `supports_reasoning_summary_parameter && summary != None` (`config_types::ReasoningSummary`; catalog `default_reasoning_summary: "none"` for all current models, so by default the CLI sends no `summary`); `context` = `"all_turns"` only on lite (`enum ReasoningContext {auto,current_turn,all_turns}`).

`reasoning.effort` wire strings (`protocol/src/openai_models.rs` `enum ReasoningEffort::as_str`): `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `persistent`, plus `Custom(String)` passthrough. Per-model supported sets (bundled catalog): gpt-6-astra / gpt-5.6-sol / gpt-5.6-terra: `low, medium, high, xhigh, max, ultra`; gpt-5.6-luna: `low, medium, high, xhigh, max`; gpt-5.5 / gpt-5.4: `low, medium, high, xhigh`. Defaults: astra/sol `low`, terra/luna/5.5/5.4 `medium`. `none`/`minimal` are in the enum but in no current model's supported list. Note `ultra` doubles as the multi-agent trigger in the CLI (`multi_agent_reasoning_effort`); Bedrock strips it.

Context: `context_window` 272000 (astra, 5.6-*, 5.5, 5.4), `max_context_window` 872000 (astra/5.6), auto-compact at 90%.

---

## 4. `instructions` handling

- Normal lane: `instructions` = `prompt.base_instructions.text` verbatim (`build_responses_request`). Default text = `BASE_INSTRUCTIONS_DEFAULT` or the per-model template from `models.json` `model_messages.instructions_template` (`protocol/src/models.rs` `struct BaseInstructions`, `BaseInstructionsProvenance::{Custom, Model}`).
- The official client supports fully custom instructions: `config.toml` `model_instructions_file` ("override the built-in instructions… STRONGLY DISCOURAGED… will likely degrade model performance" — a quality warning, not a validity one; `config/src/config_toml.rs`), and `Config.base_instructions` override (`core/src/config/mod.rs`). `BaseInstructionsProvenance::Custom`: "explicitly configured and must survive model changes unchanged".
- No code path handles an "instructions are not valid"-style rejection: repo-wide grep for such strings returns nothing; `codex-api/src/api_bridge.rs` `map_api_error` has no instruction-specific branch (400 => generic `InvalidRequest(body)`). INFERRED: at this commit the backend does not validate instructions against a Codex allowlist (historically it did for older models; the client has no remnant of that). ccp sends the Claude Code system prompt as `instructions` on the normal lane (`ccp:…/request.rs` `translate_request_inner`, `flatten_system_text`).
- `instructions` may be omitted entirely (skip-if-empty), as the lite lane does.
- Where other prompt text goes (all are `input` items, `type:"message"`, `content:[{"type":"input_text",…}]`):
  - role `developer`: permissions/sandbox text, developer_instructions override, apps/plugins/skills guidance, current-time reminders (`core/src/context/*.rs`, each `fn role() -> "developer"`).
  - role `user`: AGENTS.md user instructions and `<environment_context>` blocks, plus the real user turn.
  - role `system` is not used by the client. Mid-conversation Anthropic `system` messages => `developer` (ccp does the same, `build_input`).

---

## 5. Input item shapes

All from `protocol/src/models.rs` `enum ResponseItem` (`#[serde(tag="type", rename_all="snake_case")]`), `ContentItem`, `FunctionCallOutputPayload`.

### message
```json
{"type":"message","role":"user","content":[
  {"type":"input_text","text":"hi"},
  {"type":"input_image","image_url":"data:image/png;base64,AAAA…","detail":"high"}]}
{"type":"message","role":"assistant","content":[{"type":"output_text","text":"…"}],"phase":"final_answer"}
{"type":"message","role":"developer","content":[{"type":"input_text","text":"…"}]}
```
- optional `id` (section "ids" below), optional `phase` = `commentary|final_answer` (assistant output only; echo if received, omit otherwise), optional `internal_chat_message_metadata_passthrough` (internal; omit).
- `input_image`: either `image_url` (data URL `data:<mime>;base64,<b64>` or https URL) or `file_id` (`enum ImageReference`, untagged+flattened). `detail` optional: `auto|low|high|original`; client default `high` (`DEFAULT_IMAGE_DETAIL`), stripped on lite, `original` downgraded unless `supports_image_detail_original`.
- `input_audio {audio_url}` exists; irrelevant.
- A 400 whose body contains "The image data you provided does not represent a valid image" is special-cased (`CodexErr::InvalidImageRequest`) — validate/normalise base64 before sending (ccp re-encodes canonically and whitelists jpeg/png/gif/webp: `validated_image_data_url`).

### function_call / function_call_output
```json
{"type":"function_call","call_id":"call_abc","name":"Read","arguments":"{\"file_path\":\"/tmp/a\"}"}
{"type":"function_call_output","call_id":"call_abc","output":"plain text result"}
{"type":"function_call_output","call_id":"call_abc","output":[
  {"type":"input_text","text":"caption"},
  {"type":"input_image","image_url":"data:image/png;base64,…"}]}
```
- `arguments` is a JSON **string** (comment on `FunctionCall.arguments`). Optional `namespace` (namespaced tools only), `encrypted_function_args` (internal), `id`.
- `output` is either a string or an array of content items (`input_text`, `input_image`, `input_audio`, `encrypted_content`): custom `Serialize for FunctionCallOutputPayload`. **No `success` flag on the wire** — `success` is internal metadata ("`success` remains internal metadata"). Errors are conveyed in the text only.
- Optional `name`/`namespace` on the output item; not needed.
- Pairing invariants the client enforces before every request (`core/src/context_manager/normalize.rs`): every call has an output (synthesises `"aborted"`), orphan outputs are removed (`ensure_call_outputs_present`, `remove_orphan_outputs`). INFERRED: backend rejects unpaired calls/outputs.
- `call_id` is opaque; the client never rewrites it. Anthropic `toolu_…` ids are sent as-is by ccp as `call_id` without issue (CCP-OBSERVED).

### reasoning
```json
{"type":"reasoning","id":"rs_…","summary":[{"type":"summary_text","text":"…"}],"encrypted_content":"gAAAA…"}
```
- Fields: `id?`, `summary` (required, may be `[]`), `content?` (`reasoning_text|text` parts), `encrypted_content` (nullable).
- Serialization quirk: `content` uses `skip_serializing_if = should_serialize_reasoning_content`, which returns true (= skip) when content has no `reasoning_text` part. So raw `reasoning_text` content, when present, IS echoed back; `content: None` serialises as `"content":null`. For us: omit `content`.
- Echo rules with `store:false`:
  - Request `include:["reasoning.encrypted_content"]` every time; the `response.output_item.done` reasoning item then carries `encrypted_content`.
  - The client keeps reasoning items in history and resends them verbatim, in original order relative to the function_call/message items they preceded (history is a flat ordered `Vec<ResponseItem>`).
  - `id` is **not stripped** at this commit. `ResponseItem.id` is `Option<ResponseItemId>` with `skip_serializing_if = Option::is_none`; `prepare_response_items_for_request` only drops ids that are not `<prefix>_<suffix>` shaped (legacy bare UUIDs / empty). Test `core/tests/suite/client.rs` (~L3178-3313) asserts `body["input"][0]["id"] == "rs_reasoning-id"` with `store:false`. Missing ids are even generated client-side (`Session::assign_missing_response_item_id`, prefixes from `ResponseItem::id_prefix`: `msg`,`rs`,`fc`,`fco`,`ctc`,`ctco`,`ws`,`lsh`,`ig`,`cmp`,`at`,`tsc`,`tso`,`amsg`).
  - So: echo `{type, id, summary, encrypted_content}`; id optional but valid; `encrypted_content` is what makes the item usable statelessly. INFERRED: a reasoning item with neither server-known state nor `encrypted_content` is useless/rejected — drop thinking blocks we cannot map back. ccp replays `{id, summary:[], encrypted_content}` and skips thinking blocks without its own signature (`ccp:…/request.rs` `build_input`, `reasoning_signature.rs`).
  - Without the lite lane the server default is `reasoning.context = current_turn` (client comment): prior-turn reasoning items are accepted but INFERRED ignored/dropped server-side; they matter within a tool loop of the current turn. `x-reasoning-included` response header signals server accounted for them.

### Irrelevant to plain function tools (listed for parser tolerance)
`custom_tool_call {call_id,name,input,status?}` / `custom_tool_call_output {call_id,output}` (freeform tools: apply_patch, code-mode `exec`), `local_shell_call` (legacy), `web_search_call {id,status,action:{type:search|open_page|find_in_page,…}}` (emitted only if hosted web_search tool is registered; echo back verbatim if kept), `tool_search_call/_output`, `image_generation_call`, `compaction`/`context_compaction` (`encrypted_content`), `compaction_trigger`, `configuration_update {reasoning}`, `additional_tools` (lite only), `agent_message`. Unknown types deserialize to `Other` and are ignored.

---

## 6. Tools

### Function tool (`tools/src/responses_api.rs` `struct ResponsesApiTool`, tagged by `ToolSpec::Function` => `type:"function"`)
```json
{"type":"function","name":"Read","description":"…","strict":false,"parameters":{"type":"object","properties":{…},"required":[…],"additionalProperties":false}}
```
- `strict` always serialized; every dynamically built tool (MCP, dynamic) uses `strict:false` (`responses_api.rs:161`). `defer_loading` optional (tool-search feature; omit). `output_schema` is `#[serde(skip)]`.
- Other tool types in `enum ToolSpec`: `namespace {name,description,tools[]}`, `tool_search`, `web_search`, `custom` (freeform: `{type:"custom",name,description,format:{type:"grammar",syntax:"lark",definition}}`).

### Schema subset (`tools/src/json_schema/types.rs` `struct JsonSchema`; sanitizer `tools/src/json_schema.rs` `sanitize_json_schema`)
Tool schemas are round-tripped through a closed struct, so the client only ever emits these keywords: `$ref`, `type` (single or array of `string|number|boolean|integer|object|array|null`), `description`, `enum`, `items`, `minItems`, `properties`, `required`, `additionalProperties` (bool or schema), `anyOf`, `oneOf`, `allOf`, `$defs`, `definitions`, (`encrypted` – internal). **Everything else is silently dropped**: `pattern`, `format`, `minimum/maximum`, `minLength/maxLength`, `maxItems`, `default`, `title`, `examples`, `$schema`, `not`, `if/then/else`, `patternProperties`, `prefixItems` (sanitized then dropped), `nullable`, etc.
Sanitizer rules:
- boolean schema (`true`/`false`) => `{"type":"string"}`.
- `const: x` => `enum:[x]`.
- missing `type`: inferred `object` (has properties/required/additionalProperties), `array` (items/prefixItems), `string` (enum/format), `number` (numeric bounds); left untyped if `$ref` or a composition keyword is present; otherwise the schema is cleared to `{}`.
- `object` without `properties` => `properties:{}`; `array` without `items` => `items:{"type":"string"}`.
- `$ref` + reachable local `$defs`/`definitions` preserved; unreachable definitions pruned; malformed definition tables dropped.
- Root `{"type":"null"}` is an error.
- Size policy (`json_schema/compaction.rs`): if compact JSON > 5000 bytes, progressively strip descriptions, drop definitions, collapse objects deeper than 3, prune compositions. Client-side budget only, not a server limit.
- CCP-OBSERVED: ccp strips only `pattern` ("OpenAI's regex dialect differs"), passes everything else through with `strict:false` (`ccp:…/request.rs` `strip_tool_schema_patterns`). So with `strict:false` the backend tolerates extra keywords; bad regex `pattern` is the known rejection. Safest for us: emit the official subset above.

### Names
- `^[a-zA-Z0-9_-]+$` ("The Responses API requires tool names to match…": `codex-mcp/src/mcp/mod.rs` `sanitize_responses_api_tool_name`, which actually maps anything not `[A-Za-z0-9_]` to `_`).
- Length: client caps MCP-qualified names at 128 (`codex-mcp/src/tools.rs` `MAX_TOOL_NAME_LENGTH`), dynamic tools name <=128, namespace <=64 (`app-server/…/thread_processor.rs` `validate_dynamic_tools`). Older 64-char limit is gone in source. Claude Code names (incl. `mcp__server__tool`) fit the charset.
- Reserved namespace names (only relevant if using `namespace`): `api_tool, browser, computer, container, file_search, functions, image_gen, multi_tool_use, python, python_user_visible, submodel_delegator, terminal, …`.

### Hosted web search
`{"type":"web_search","external_web_access":true|false,"indexed_web_access"?,"filters"?:{"allowed_domains":[…]},"user_location"?:{type,country,region,city,timezone},"search_context_size"?,"search_content_types"?:["text","image"]}` (`ToolSpec::WebSearch`). Source comment notes `{type:"web_search"}` bare form errored at some point. Not accepted on the lite lane. CCP-OBSERVED: forcing `tool_choice` to web_search when it is not registered makes upstream 502.

### `tool_mode: code_mode_only`
- `enum ToolMode {direct, code_mode, code_mode_only}` (`protocol/src/openai_models.rs`); resolved by `core/src/tools/mod.rs` `requested_tool_mode`/`effective_tool_mode` (model metadata wins over feature flags).
- It is purely a **client-side presentation policy**: in code mode the client registers a freeform `custom` tool `exec` (JavaScript run in a local V8 isolate, Lark grammar; `core/src/tools/code_mode/execute_spec.rs` `create_code_mode_tool`, `code-mode-protocol/src/description.rs`) plus a `wait` function tool; ordinary tools become methods on a JS `tools` object described inside `exec`'s description. With `code_mode_only`, tools that are code-mode-capable are hidden from the top-level tool list (`spec_plan.rs` `is_hidden_by_code_mode_only`); tools marked `ToolExposure::DirectModelOnly` remain top-level function tools ("keeps the tool callable as a normal model tool").
- So even for code_mode_only models the request still carries ordinary `function` tool definitions (`wait`, direct-only tools) and the model emits ordinary `function_call` items. Nothing on the wire says "code mode"; the server is not told the tool_mode (the old `code_mode_tool_names` metadata key is explicitly retired: `LEGACY_CODE_MODE_TOOL_NAMES_KEY`).
- Bedrock runs the same models with `tool_mode = None` (direct function tools). INFERRED: plain function tools are accepted for gpt-6-astra / gpt-5.6-*; the model is merely tuned to prefer orchestrating via `exec`. We simply present Claude Code's tools as direct function tools.

---

## 7. SSE response events

Parser: `codex-api/src/sse/responses.rs` `process_sse_with_treatment` + `process_responses_event`. Each SSE `data:` is one JSON object; **the JSON `type` field is authoritative** (the SSE `event:` name is ignored). Unparseable JSON is skipped. Struct `ResponsesStreamEvent {type, response?, item?, item_id?, call_id?, delta?, text?, summary_index?, content_index?, headers?, metadata?, safety_buffering?}`.

| `type` | Fields used | Client action |
|---|---|---|
| `response.created` | `response.id` | `Created{response_id}` |
| `response.output_item.added` | `item` (full item object) | `OutputItemAdded`; first one marks TTFT |
| `response.output_item.done` | `item` | `OutputItemDone` — **source of truth** for messages, `function_call` (`call_id`,`name`,`arguments`), `reasoning` (`id`,`summary`,`encrypted_content`) |
| `response.output_text.delta` | `delta` | text streaming |
| `response.reasoning_summary_part.added` | `summary_index` | new summary section |
| `response.reasoning_summary_text.delta` | `delta`, `summary_index` | summary streaming |
| `response.reasoning_summary_text.done` | `item_id`, `text`, `summary_index` | |
| `response.reasoning_text.delta` | `delta`, `content_index` | raw reasoning (open-weight style) |
| `response.custom_tool_call_input.delta` | `delta`, `item_id`\|`call_id` | freeform tool input streaming |
| `response.completed` | `response.id`, `response.usage`, `response.end_turn?` | terminal success; parser returns right after |
| `response.failed` | `response.error {type?, code?, message?, plan_type?, resets_at?}` | error stored, surfaced when stream closes |
| `response.incomplete` | `response.incomplete_details.reason` | error `"Incomplete response returned, reason: {reason}"` |
| explicitly ignored | `response.function_call_arguments.delta`, `response.function_call_arguments.done`, `response.content_part.added/done`, `response.output_text.done`, `response.in_progress`, `response.reasoning_summary_part.done`, `response.custom_tool_call_input.done`, `response.metadata`, `codex.response.metadata`, `responsesapi.websocket_timing`, any other `*.delta` | trace log only |

- The official client does NOT stream function-call arguments; it waits for `output_item.done`. For an Anthropic-style stream we can forward `response.function_call_arguments.delta` (`output_index`, `item_id`, `delta`) as `input_json_delta` — ccp does (`ccp:…/translate/reducer.rs`), keyed by `output_index`, falling back to `arguments` from `.done`/`output_item.done` when no deltas arrived.
- `response.metadata` side-channels: `headers["x-codex-turn-state"]`, `headers["openai-model"]`, `metadata.openai_verification_recommendation`, `metadata.openai_chatgpt_moderation_metadata`, `metadata.type=="safety_buffering"`. Also any event's `response.headers["openai-model"|"x-openai-model"]` => `ServerModel`.
- Usage (`struct ResponseCompletedUsage`): `input_tokens` (i64, required), `input_tokens_details.cached_tokens`, `input_tokens_details.cache_write_tokens` (default 0), `output_tokens` (required), `output_tokens_details.reasoning_tokens`, `total_tokens` (required), `codex_rollout_budget_units?`. If `usage` is present but lacks a required field, the whole `response.completed` fails to parse. `input_tokens` INCLUDES cached tokens (ccp: Anthropic `input_tokens = input_tokens - cached_tokens`, `cache_read_input_tokens = cached_tokens`, `cache_creation_input_tokens = 0`: `map_codex_usage_to_anthropic`).
- `end_turn: bool?` on completed — optional hint; when absent the client infers turn end from absence of tool calls.
- Rate limits over SSE: **not** an SSE event on the HTTP path. `codex.rate_limits` (`{type, plan_type?, rate_limits:{primary?,secondary?:{used_percent,window_minutes?,reset_at?}}, credits?:{has_credits,unlimited,balance?}, metered_limit_name?, limit_name?}`) is parsed only on the WebSocket path (`codex-api/src/rate_limits.rs` `parse_rate_limit_event`, `endpoint/responses_websocket.rs:756`). On HTTP they arrive as response headers (section 8). ccp tolerates `codex.rate_limits` and a `keepalive` typed event in the SSE stream (CCP-OBSERVED), mapping both to Anthropic `ping`.
- Keepalive: SSE comment lines are swallowed by the eventsource parser; unknown `type`s are ignored. Idle timeout between events: `stream_idle_timeout` default 300 000 ms (`DEFAULT_STREAM_IDLE_TIMEOUT_MS`) => `"idle timeout waiting for SSE"` (retryable).
- Stream end: success = `response.completed` seen (client stops reading immediately). If the body ends first => stored `response.failed`/`response.incomplete` error, else `"stream closed before response.completed"` (retryable). There is no `[DONE]` sentinel.

---

## 8. Errors and limits

HTTP-level (`codex-api/src/api_bridge.rs` `map_api_error`, body shape `{"error":{…}}`):

| Status | Body match | Client result |
|---|---|---|
| 401 | any | recoverable: `handle_unauthorized` -> `UnauthorizedRecovery` state machine: (1) reload auth.json from disk if account id matches, retry; (2) OAuth refresh, retry; then fail (`login/src/auth/manager.rs` comment above `struct UnauthorizedRecovery`) |
| 400 | `error.code` = `cyber_policy` / `bio_policy` | policy errors |
| 400/403 | `error.code` = `misalignment_policy_violation` | policy error |
| 400 | body contains "The image data you provided does not represent a valid image" | `InvalidImageRequest` |
| 400 | else | `InvalidRequest(body)` — not retried |
| 429 | `error.type == "usage_limit_reached"` | `UsageLimitReached{plan_type, resets_at, rate_limits(from headers), promo_message, rate_limit_reached_type}` — not retried |
| 429 | `error.type == "usage_not_included"` | `UsageNotIncluded` |
| 429 | `error.type == "insufficient_quota"` or `error.code` in `insufficient_quota, credit_balance_exhausted, organization_spend_limit_exceeded, project_spend_limit_exceeded, organization_usage_limit_exceeded` | `QuotaExceeded` |
| 429 | else | `RetryLimit` |
| 500 | | `InternalServerError` (retryable at stream level) |
| 503 | `error.code == "server_is_overloaded"` / `"slow_down"` | `ServerOverloaded` (not retried) / `RateLimitExceeded` |
| 403 | body contains "Cloudflare" and "blocked" | friendly "Access blocked by Cloudflare…" |
| other | | `UnexpectedStatus{status, body, cf-ray, x-request-id\|x-oai-request-id, x-openai-authorization-error, x-error-json (base64 JSON -> error.code)}` |

429 usage-limit payload (`struct UsageErrorBody`): `{"error":{"type":"usage_limit_reached","code"?,"message","plan_type":"plus|pro|…","resets_at":<unix seconds>}}`. The backend also sends `resets_in_seconds` (seen in test fixture `core/tests/suite/client_websockets.rs:1844`) but the current client parses only `resets_at`. Accept both.

In-stream `response.failed` `error.code` mapping (`sse/responses.rs`): `context_length_exceeded` -> ContextWindowExceeded; `insufficient_quota|credit_balance_exhausted|organization_spend_limit_exceeded|project_spend_limit_exceeded` -> QuotaExceeded; `usage_not_included`; `cyber_policy`; `bio_policy`; `misalignment_policy_violation`; `invalid_prompt` -> InvalidRequest(message); `server_is_overloaded`; `rate_limit_exceeded|slow_down` -> RateLimitExceeded with delay parsed from message by regex `(?i)try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)`; anything else -> Retryable.

Retry policy: request level (`to_api_provider`): `max_attempts = request_max_retries` (default 4), base delay 200 ms, exponential x2 with 0.9–1.1 jitter, `retry_429:false`, `retry_5xx:true`, `retry_transport:true` (`codex-client/src/retry.rs`). Stream level: `stream_max_retries` default 5 (`core/src/responses_retry.rs`, `CodexErr::retry_delay` lists retryable kinds: Stream, RateLimitExceeded, timeouts, UnexpectedStatus, ConnectionFailed, InternalServerError; non-retryable: UsageLimitReached, QuotaExceeded, InvalidRequest, ContextWindowExceeded, ServerOverloaded, policy errors).

Rate-limit response headers (`codex-api/src/rate_limits.rs`), present on 200 and 429:
`x-codex-primary-used-percent` (float), `x-codex-primary-window-minutes`, `x-codex-primary-reset-at` (unix s), `x-codex-secondary-used-percent`, `x-codex-secondary-window-minutes`, `x-codex-secondary-reset-at`, `x-codex-credits-has-credits`, `x-codex-credits-unlimited`, `x-codex-credits-balance`, `x-codex-limit-name`, `x-codex-active-limit` (names the limit family that tripped), `x-codex-rate-limit-reached-type`, `x-codex-promo-message`; test fixtures also show `x-codex-primary-over-secondary-limit-percent`. Additional families use prefix `x-<limit-id-with-dashes>-…` (e.g. `x-codex-other-primary-used-percent`).

---

## 9. auth.json (`$CODEX_HOME/auth.json`, default `~/.codex/auth.json`, mode 0600)

`login/src/auth/storage.rs` `struct AuthDotJson` — field names only:
`auth_mode?` (`apiKey|chatgpt|chatgptAuthTokens|headers|agentIdentity|personalAccessToken|bedrock…`), `OPENAI_API_KEY`, `tokens?`, `last_refresh?` (RFC3339 UTC), `agent_identity?`, `personal_access_token?`, `bedrock_api_key?`, `bedrock_access_keys?`.
`tokens` = `login/src/token_data.rs` `struct TokenData`: `id_token` (raw JWT string on disk), `access_token` (JWT), `refresh_token`, `account_id?`.

- The file exists only when `cli_auth_credentials_store = file` (default) or `auto` without a keyring (`config/src/types.rs` `AuthCredentialsStoreMode {file, keyring, auto, ephemeral}`).
- Bearer = `tokens.access_token` (`CodexAuth::get_token`). `get_token_data` requires both `tokens` and `last_refresh` to be present.
- Account id = file field `tokens.account_id` (`CodexAuth::get_account_id`). It is written at login from the **id_token** JWT claim `["https://api.openai.com/auth"]["chatgpt_account_id"]` (`login/src/server.rs` `persist_tokens_async`). Fallback for us if the field is null: decode the id_token (or access_token) payload, same claim path. Other claims under that object: `chatgpt_plan_type`, `chatgpt_user_id`/`user_id`, `chatgpt_account_is_fedramp`, `chatgpt_account_user_id`; email at top-level `email` or `["https://api.openai.com/profile"].email`.
- JWT `exp`: `parse_jwt_expiration` base64url-decodes (no padding) the payload of `access_token` and reads integer `exp` (seconds). No signature verification.
- Refresh timing (`AuthManager::should_refresh_proactively`, called from `AuthManager::auth()` which runs before every model request via `current_client_setup`):
  - if `access_token.exp` parses: refresh when `exp <= now + 5 min` (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5`);
  - else: refresh when `last_refresh < now - 8 days` (`TOKEN_REFRESH_INTERVAL = 8`);
  - plus reactive on 401 (section 8).
- Refresh procedure (`refresh_token` -> `reload_if_account_id_matches` -> `refresh_token_from_authority_impl` -> `persist_tokens`): first re-read auth.json; if another process already changed it, adopt that and skip; else `POST https://auth.openai.com/oauth/token` JSON `{grant_type:"refresh_token", client_id:"app_EMoamEEZ73f0CkXaXp7hrann", refresh_token}` (`login/src/oauth/client.rs`, `CLIENT_ID`); response `{id_token?, access_token?, refresh_token?}`; the file is rewritten with new tokens and `last_refresh = now`. Refresh tokens rotate: error codes `refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated` are permanent failures.
- Consequences for claudex: (a) never refresh ourselves — a second refresher would burn the rotating refresh token (`refresh_token_reused`) and log the user out of Codex; (b) running any Codex CLI command that makes a model request (e.g. `codex exec`) within 5 min of expiry, or after expiry, rewrites auth.json with a fresh access token; (c) re-read auth.json on every request or on 401 (official client does the same reload-first step); (d) compare `exp` ourselves and tell the user to run `codex` when expired.

---

## 10. Anthropic -> Responses gotchas handled by raine/claude-code-proxy (cross-check)

All in `ccp:src/providers/codex/translate/` unless noted.
- System prompt: `system` blocks joined with `\n\n` into `instructions`; blocks starting with `x-anthropic-billing-header:` are dropped (`ccp:src/providers/translate_shared.rs` `flatten_system_text`). On lite it is moved to a leading `developer` message (`request.rs` `translate_request_inner`).
- Mid-conversation `system` role messages -> `developer` message items (`request.rs` `build_input`).
- User message containing `tool_result` blocks: text/image parts before it are flushed as a `user` message first, then a `function_call_output` item, preserving order (`build_input`).
- `tool_result` with images: `output` becomes an array of `input_text` / `input_image` (data URL); text-only results stay a plain string (`function_call_output`). URL-source images become the text `[image omitted: url]`; invalid base64 / unsupported mime (`image/jpeg|png|gif|webp` only) becomes placeholder text; base64 is decoded and canonically re-encoded (`validated_image_data_url`).
- `tool_result.is_error` -> text prefix `[tool execution error]` (no wire flag exists) (`build_input`).
- Empty / non-text tool_result content -> empty string output; unknown block types -> `[unsupported content block omitted: <type>]` (`render_tool_result_block`).
- Assistant `tool_use` -> `function_call` with `call_id` = Anthropic id verbatim and `arguments` = JSON-stringified input; assistant text before it is flushed as its own `assistant` message with `output_text` parts (`build_input`). Empty text messages are never emitted (parts vec checked non-empty).
- Thinking roundtrip: upstream reasoning `id` + `encrypted_content` are packed into the Anthropic `signature` (`ccp:codex:v1:<b64url id>:<encrypted_content>`), and on the way back decoded into `{type:reasoning,id,summary:[],encrypted_content}`; thinking blocks with foreign signatures are dropped (`reasoning_signature.rs`, `build_input`).
- `include:["reasoning.encrypted_content"]` and `reasoning` only sent when an effort is resolved (`translate_request_inner`); summary `"auto"` when thinking requested.
- Tools: `input_schema` -> `parameters`, `strict:false`; `pattern` keywords stripped recursively through schema-bearing keywords only (`strip_tool_schema_patterns`); Anthropic `web_search_20250305` -> hosted `{type:"web_search",external_web_access:true,search_content_types:["text","image"],filters?}` (`read_tools`).
- `tool_choice`: `auto|none` same; `any` -> `required`; `{type:tool,name}` -> `{type:"function",name}`; forced web_search -> `allowed_tools`; downgraded to `auto` if web_search not registered because upstream 502s (`map_tool_choice`, `translate_request_inner`).
- `max_tokens`: not forwarded at all (test `max_tokens_is_not_serialized_for_codex`); `temperature` etc. likewise absent from `ResponsesRequest`.
- `text.verbosity:"low"` always; `store:false`, `stream:true` always; `prompt_cache_key` = session id; `parallel_tool_calls` default true (false on lite).
- Stop reasons: `response.incomplete`/status incomplete -> `max_tokens`; any function call seen -> `tool_use`; else `end_turn` (`reducer.rs` ~L841). Only `incomplete_details.reason == "max_output_tokens"` is treated as a clean stop; other incompletes are errors (`ccp:…/events.rs`).
- Usage: `input_tokens = upstream.input_tokens - cached_tokens`, `cache_read_input_tokens = cached_tokens`, `cache_creation_input_tokens = 0`, `output_tokens` as is (`reducer.rs` `map_codex_usage_to_anthropic`). `message_start` carries an estimated input token count since real usage only arrives at the end (`stream.rs`).
- Streaming tool args: `response.function_call_arguments.delta` keyed by `output_index`; falls back to `.done.arguments` / `output_item.done.item.arguments` if no deltas; cap on buffered arg bytes (`reducer.rs`).
- Keepalive: `codex.rate_limits`, `keepalive`, `response.created`, `response.in_progress` -> Anthropic `ping` (`live_stream.rs`).
- Model-behaviour patch: GPT models misuse Claude Code's `Read.offset`; ccp rewrites the tool description and repairs args (`read_rewrite.rs`, `codex_tool_parameters`). Behavioural, not protocol.
- Headers ccp sends: `originator: claude-code-proxy` + `User-Agent: claude-code-proxy/<ver>` on the normal lane (so a non-Codex originator is accepted there, CCP-OBSERVED), but `codex_cli_rs` on the lite lane; legacy `OpenAI-Beta: responses=experimental`; `x-codex-beta-features: remote_compaction_v2`; `session-id`, `x-client-request-id`, `x-codex-window-id: <sid>:0` (`ccp:src/providers/codex/client.rs` `build_codex_headers`).

---

## 11. Minimal honest request

Only fields verified above. No lite header, no `x-codex-*`, no `version`, no `OpenAI-Beta`, no `client_metadata`.

Headers (both examples):
```
POST /backend-api/codex/responses HTTP/1.1
Host: chatgpt.com
Authorization: Bearer $ACCESS_TOKEN
ChatGPT-Account-ID: $ACCOUNT_ID
Content-Type: application/json
Accept: text/event-stream
originator: claude-code
User-Agent: claudex/0.1 (Claude Code; third-party harness)
session-id: $SESSION_UUID
```
`session-id` is optional (cache affinity); use the same value as `prompt_cache_key`.

(a) Plain text turn — save as `body-a.json`:
```json
{
  "model": "gpt-5.6-sol",
  "instructions": "You are a coding assistant running inside Claude Code.",
  "input": [
    {"type": "message", "role": "user",
     "content": [{"type": "input_text", "text": "Say hello in one word."}]}
  ],
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": {"effort": "low", "summary": "auto"},
  "store": false,
  "stream": true,
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "$SESSION_UUID",
  "text": {"verbosity": "low"}
}
```

(b) Turn with one function tool, second leg of the loop (echoing reasoning + call + output) — `body-b.json`:
```json
{
  "model": "gpt-5.6-sol",
  "instructions": "You are a coding assistant running inside Claude Code.",
  "input": [
    {"type": "message", "role": "user",
     "content": [{"type": "input_text", "text": "What is in /tmp/a.txt?"}]},
    {"type": "reasoning", "id": "rs_0123", "summary": [],
     "encrypted_content": "<opaque string from response.output_item.done>"},
    {"type": "function_call", "call_id": "call_abc123", "name": "Read",
     "arguments": "{\"file_path\":\"/tmp/a.txt\"}"},
    {"type": "function_call_output", "call_id": "call_abc123",
     "output": "     1\thello world"}
  ],
  "tools": [
    {"type": "function", "name": "Read",
     "description": "Reads a file from the local filesystem.",
     "strict": false,
     "parameters": {
       "type": "object",
       "properties": {
         "file_path": {"type": "string", "description": "Absolute path"},
         "offset": {"type": "integer"},
         "limit": {"type": "integer"}
       },
       "required": ["file_path"],
       "additionalProperties": false
     }}
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": {"effort": "medium", "summary": "auto"},
  "store": false,
  "stream": true,
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "$SESSION_UUID",
  "text": {"verbosity": "low"}
}
```
First leg of (b) = same body with only the user message in `input`.

curl (do not run from automation; for manual testing by the user):
```sh
curl -N https://chatgpt.com/backend-api/codex/responses \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "ChatGPT-Account-ID: $ACCOUNT_ID" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -H "originator: claude-code" \
  -H "User-Agent: claudex/0.1 (Claude Code; third-party harness)" \
  -H "session-id: $SESSION_UUID" \
  --data @body-a.json
```
Notes: `summary` may be dropped to match CLI defaults (catalog `default_reasoning_summary: none`); `tools: []` may be omitted; `gpt-5.5` is the conservative model choice (non-lite in the official catalog, so the normal lane is its native lane).

---

## 12. Open questions (not resolvable from source)

1. **Normal lane for lite-catalog models.** Does `chatgpt.com/backend-api/codex/responses` serve `gpt-5.6-sol/terra` and `gpt-6-astra` without `x-openai-internal-codex-responses-lite`? Source only shows the official client always sets it for them. CCP-OBSERVED says yes for sol (and implicitly terra/astra), no for `gpt-5.6-luna` (404 "Model not found gpt-5.6-luna-free-…", possibly plan-dependent). Needs a live probe by the user. `gpt-5.5`/`gpt-5.4` are non-lite in the catalog and are the safe fallback (haiku-tier has no confirmed non-lite model).
2. **Originator gating.** Is any lane/model gated on a first-party `originator`/User-Agent? ccp switches to `codex_cli_rs` only for lite, which suggests lite may be; the normal lane demonstrably accepts `claude-code-proxy`. Unknown for `claude-code`.
3. **Instruction validation.** No client evidence of server-side instruction allowlisting at this commit, and the CLI supports custom instructions; but whether some models/plans still enforce it is server-side. If a 400 mentions instructions, fallback = move the Claude Code system prompt into a leading `developer` message and send short/no `instructions`.
4. **`reasoning.context` on the normal lane.** Client comment says default is `current_turn`. Whether `context:"all_turns"` is honoured without the lite header, and whether prior-turn reasoning items are dropped silently or cost tokens, is unknown. Also unknown: whether the server rejects a reasoning item whose `id` it cannot resolve when `encrypted_content` is present (official client always sends both, so both together are safe).
5. **`max_output_tokens` / `temperature`.** Never sent by either client; whether the backend rejects (400 "Unsupported parameter") or ignores them is untested here. Do not send. Consequence: Anthropic `max_tokens` cannot be enforced upstream.
6. **`tool_choice` object forms** (`{type:"function",name}`, `required`, `none`): official client only ever sends `"auto"`. ccp sends the others (CCP-OBSERVED working).
7. **Uncompressed bodies / size limits.** CLI zstd-compresses by default; max accepted request size (large base64 images, 272k-token contexts) unknown.
8. **Required-ness of `ChatGPT-Account-ID`** for single-workspace personal accounts, and whether `session-id` affects anything beyond cache affinity.
9. **SSE extras on the HTTP path.** Whether `codex.rate_limits` / `keepalive` typed events actually appear over HTTP SSE (ccp handles them; official HTTP parser would just ignore them). Parser must tolerate unknown `type`s regardless.
10. **`strict:false` schema tolerance.** Exact set of JSON-Schema keywords the backend rejects is unknown; only `pattern` (regex dialect) is reported. Emitting the official subset (section 6) sidesteps this.
11. **Parallel tool calls on 5.6/astra via the normal lane.** Lite forces `false`; whether these models emit parallel calls correctly with `true` on the normal lane is unverified.
