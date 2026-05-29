# Graph Report - src  (2026-05-29)

## Corpus Check
- Corpus is ~47,714 words - fits in a single context window. You may not need a graph.

## Summary
- 550 nodes · 1285 edges · 25 communities (16 shown, 9 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 34 edges (avg confidence: 0.83)
- Token cost: 235,277 input · 4,000 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Role Orchestrator & Planning|Role Orchestrator & Planning]]
- [[_COMMUNITY_OpenAI-Compat Providers|OpenAI-Compat Providers]]
- [[_COMMUNITY_Web App Shell & Wiring|Web App Shell & Wiring]]
- [[_COMMUNITY_Provider Pool & Cooldown|Provider Pool & Cooldown]]
- [[_COMMUNITY_Mindmap Catalyst & Composer UI|Mindmap Catalyst & Composer UI]]
- [[_COMMUNITY_File & Bash Tools|File & Bash Tools]]
- [[_COMMUNITY_Chat REPL & Session|Chat REPL & Session]]
- [[_COMMUNITY_Ollama & Config Loaders|Ollama & Config Loaders]]
- [[_COMMUNITY_Mindmap Templates & Categorize|Mindmap Templates & Categorize]]
- [[_COMMUNITY_Agent  Controller  Router Core|Agent / Controller / Router Core]]
- [[_COMMUNITY_CLI Commands|CLI Commands]]
- [[_COMMUNITY_Provider Cross-Cutting Concerns|Provider Cross-Cutting Concerns]]
- [[_COMMUNITY_Role Registry & Failover|Role Registry & Failover]]
- [[_COMMUNITY_Gemini Provider|Gemini Provider]]
- [[_COMMUNITY_Phase Error Boundary|Phase Error Boundary]]
- [[_COMMUNITY_Settings Drawer|Settings Drawer]]
- [[_COMMUNITY_Sidebar & Usage Gauges|Sidebar & Usage Gauges]]
- [[_COMMUNITY_Mindmap Data Derivation|Mindmap Data Derivation]]
- [[_COMMUNITY_Orbital Layout Geometry|Orbital Layout Geometry]]
- [[_COMMUNITY_Chat Turn Rendering|Chat Turn Rendering]]
- [[_COMMUNITY_Orbital Mindmap View|Orbital Mindmap View]]
- [[_COMMUNITY_Markdown Rendering|Markdown Rendering]]
- [[_COMMUNITY_Completion Text Extraction|Completion Text Extraction]]
- [[_COMMUNITY_OpenAI Tools Array|OpenAI Tools Array]]
- [[_COMMUNITY_Retry-After Header Parsing|Retry-After Header Parsing]]

## God Nodes (most connected - your core abstractions)
1. `CompleteOptions` - 65 edges
2. `ConversationPart` - 37 edges
3. `Router` - 36 edges
4. `RoleName` - 30 edges
5. `RoleResolver` - 29 edges
6. `ChatSession` - 27 edges
7. `Provider` - 22 edges
8. `ToolDeclaration` - 19 edges
9. `ProviderPool` - 18 edges
10. `chatCompletion()` - 17 edges

## Surprising Connections (you probably didn't know these)
- `index.html app shell` --conceptually_related_to--> `startWebServer`  [INFERRED]
  src/web/static/index.html → src/web/server.ts
- `ProviderState` --references--> `Provider`  [EXTRACTED]
  pool.ts → provider.ts
- `PickResult` --references--> `Provider`  [EXTRACTED]
  pool.ts → provider.ts
- `PoolOptions` --references--> `StateStore`  [EXTRACTED]
  pool.ts → state.ts
- `Router` --references--> `ProviderPool`  [EXTRACTED]
  router.ts → pool.ts

## Hyperedges (group relationships)
- **Provider failover + quota conservation loop** — router_complete, pool_pickAvailable, conservation_ConservationPolicy, pool_snapshot [INFERRED 0.85]
- **Smart-routing orchestration (plan/single/parallel)** — session_planAndExecute, orch_parsePlan, orch_Plan, session_ChatProgressEvent [INFERRED 0.85]
- **Persisted per-provider usage tracking** — pool_ProviderPool, state_FileStateStore, state_ProviderUsage [INFERRED 0.85]
- **OpenAI-compatible provider family** — cerebras_CerebrasProvider, groq_GroqProvider, mistral_MistralProvider, openrouter_OpenRouterProvider, openaicompat_chatCompletion [INFERRED 0.95]
- **Provider interface implementers** — cerebras_CerebrasProvider, groq_GroqProvider, mistral_MistralProvider, openrouter_OpenRouterProvider, gemini_GeminiProvider, ollama_OllamaProvider [INFERRED 0.85]
- **Tool interface implementations** — bashtool_BashTool, filetools_FileTools, websearch_WebSearchTool, tooltypes_Tool, runner_ToolRunner [INFERRED 0.85]

## Communities (25 total, 9 thin omitted)

### Community 0 - "Role Orchestrator & Planning"
Cohesion: 0.06
Nodes (40): AgentOptions, isValidRoleName(), parsePlan(), Plan, RoleOrchestrator, RoleOrchestratorOptions, RoleRunTrace, VALID_ROLE_NAMES (+32 more)

### Community 1 - "OpenAI-Compat Providers"
Cohesion: 0.10
Nodes (26): CerebrasProvider, CerebrasProviderOptions, GroqProvider, GroqProviderOptions, MistralProvider, MistralProviderOptions, buildChatBody(), buildOpenAIToolsArray() (+18 more)

### Community 2 - "Web App Shell & Wiring"
Cohesion: 0.06
Nodes (48): Agent (stateless lens wrapper), CatalystOverlay animation, app.jsx HeroMindmap App, MM_AGENTS roster (5 visible roles), SettingsDrawer (CLI flags as toggles), /api/chat-stream SSE consumer, extractFirstJsonObject, useUsage poller (+40 more)

### Community 3 - "Provider Pool & Cooldown"
Cohesion: 0.07
Nodes (17): PickResult, PoolMode, PoolOptions, ProviderConfig, ProviderPool, ProviderSnapshot, ProviderState, QuotaSource (+9 more)

### Community 4 - "Mindmap Catalyst & Composer UI"
Cohesion: 0.05
Nodes (8): ANGLE_TABLES_DEG, COLLAPSE_TIMELINE, DEFAULT_SETTINGS, MM_AGENTS, ORBIT_LAYOUT_CONSTS, ROUTING_OPTIONS, VALID_FORCE_ROLES, VALID_ROUTING_MODES

### Community 5 - "File & Bash Tools"
Cohesion: 0.09
Nodes (11): BashTool, BashToolOptions, FileTools, ToolRunner, ToolRunnerOptions, ToolRunResult, Tool, ToolCallRecord (+3 more)

### Community 6 - "Chat REPL & Session"
Cohesion: 0.11
Nodes (5): ChatRepl, ReplOptions, ChatSession, FRAMES, startSpinner()

### Community 7 - "Ollama & Config Loaders"
Cohesion: 0.09
Nodes (19): historyToOllamaMessages(), OllamaMessage, OllamaProvider, OllamaProviderOptions, DEFAULT_BUDGETS, DEFAULT_COOLDOWN_MS, DEFAULT_RPM, __dirname (+11 more)

### Community 8 - "Mindmap Templates & Categorize"
Cohesion: 0.09
Nodes (17): clampItems(), cleanHeading(), cleanText(), comparisonNames(), deriveMindmapData(), extractCodeFences(), extractNodes(), FALLBACK_DATA (+9 more)

### Community 9 - "Agent / Controller / Router Core"
Cohesion: 0.11
Nodes (9): Agent, Controller, ControllerMode, ControllerOptions, RunTrace, buildRoutingPrompt(), buildSynthesisPrompt(), ConservationPolicy (+1 more)

### Community 10 - "CLI Commands"
Cohesion: 0.16
Nodes (26): listSessions(), buildDefaultRoles(), buildDefaultAgents(), buildRouter(), cmdAgents(), cmdAsk(), cmdAskRole(), cmdAskWithTools() (+18 more)

### Community 11 - "Provider Cross-Cutting Concerns"
Cohesion: 0.11
Nodes (27): BashTool, CerebrasProvider, FileTools, FileTools.resolveSafe (path confinement), GeminiProvider, appendSources, historyToGeminiContents, parseGeminiRetryDelayMs (+19 more)

### Community 12 - "Role Registry & Failover"
Cohesion: 0.14
Nodes (17): DEFAULT_ROLES, buildDefaultRoles, Reserved-key role isolation (gemini:3, gemma:3), Gemini 404 model-retirement failover, index.html app shell, RoleResolver, Cross-role failover strategy, RoleResolver.runWithStrategy (+9 more)

### Community 13 - "Gemini Provider"
Cohesion: 0.21
Nodes (8): appendSources(), extractStatus(), GeminiProvider, GeminiProviderOptions, historyToGeminiContents(), parseDurationToMs(), parseGeminiRetryDelayMs(), parseToolResponse()

### Community 15 - "Settings Drawer"
Cohesion: 0.50
Nodes (4): HeroMindmap(), routingValueFromSettings(), settingsActiveCount(), SettingsDrawer()

### Community 16 - "Sidebar & Usage Gauges"
Cohesion: 0.50
Nodes (4): CompactNumber(), QuotaBanner(), Sidebar(), useUsage()

## Knowledge Gaps
- **70 isolated node(s):** `VALID_ROLES`, `VALID_THINKING`, `__filename`, `__dirname`, `DEFAULT_BUDGETS` (+65 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `CompleteOptions` connect `OpenAI-Compat Providers` to `Role Orchestrator & Planning`, `File & Bash Tools`, `Chat REPL & Session`, `Ollama & Config Loaders`, `Agent / Controller / Router Core`, `CLI Commands`, `Gemini Provider`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **Why does `ChatSession` connect `Chat REPL & Session` to `Role Orchestrator & Planning`, `OpenAI-Compat Providers`, `CLI Commands`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `ProviderPool` connect `Provider Pool & Cooldown` to `Role Orchestrator & Planning`, `Agent / Controller / Router Core`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **What connects `VALID_ROLES`, `VALID_THINKING`, `__filename` to the rest of the system?**
  _77 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Role Orchestrator & Planning` be split into smaller, more focused modules?**
  _Cohesion score 0.05700852189244784 - nodes in this community are weakly interconnected._
- **Should `OpenAI-Compat Providers` be split into smaller, more focused modules?**
  _Cohesion score 0.10357304387155133 - nodes in this community are weakly interconnected._
- **Should `Web App Shell & Wiring` be split into smaller, more focused modules?**
  _Cohesion score 0.05673758865248227 - nodes in this community are weakly interconnected._