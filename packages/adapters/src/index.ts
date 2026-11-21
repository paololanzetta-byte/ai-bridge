export { ScriptedAdapter, type ScriptedOptions } from './scripted.js';
export { DEMO_GOAL, DEMO_CLAUDE, DEMO_CHATGPT } from './demo-scripts.js';
export { ClaudeAdapter, toClaudeMessages, costGbp, type ClaudeConfig } from './claude.js';
export { ChatGPTAdapter, type ChatGPTConfig } from './chatgpt.js';
export { buildSystemPrompt, parseReply, toRoleMessages, type RoleMessage } from './protocol.js';
export { sseEvents, type StreamEvent } from './sse.js';
