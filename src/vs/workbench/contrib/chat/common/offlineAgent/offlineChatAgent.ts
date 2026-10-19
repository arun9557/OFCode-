/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import {
	IChatAgentImplementation,
	IChatAgentRequest,
	IChatAgentResult,
	IChatAgentService,
	IChatAgentHistoryEntry,
	IChatAgentData
} from '../participants/chatAgents.js';
import { IChatProgress } from '../chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../constants.js';
import {
	ILanguageModelsService,
	IChatMessage,
	ChatMessageRole,
	IChatResponsePart,
	ILanguageModelChatMetadata
} from '../languageModels.js';
import { ILanguageModelToolsService, IToolInvocation } from '../tools/languageModelToolsService.js';
import { WebExtractorService } from './webExtractor/webExtractorService.js';
import { HighRagService } from './highRag/highRagService.js';
import { EmbeddingClient } from './highRag/embeddingClient.js';
import { OllamaClient } from './ollamaClient.js';
import { ToolCallParser } from './toolCallParser.js';
import { IDEExecutionOrchestrator } from './ideExecutionOrchestrator.js';
import { KiroSpecEngine } from './kiroSpecEngine.js';

import { IRequestService } from '../../../../../platform/request/common/request.js';

export const OFFLINE_AGENT_ID = 'ofcode.offlineAgent';

const OFCODE_AGENT_TOOLS = [
	'vscode_chromeExtract',
	'vscode_highRag',
	'vscode_githubExplore',
	'ofcode_readFile',
	'ofcode_writeFile',
	'ofcode_editFile',
	'ofcode_listFiles',
	'ofcode_runCommand'
] as const;

export class OfflineChatAgent extends Disposable implements IChatAgentImplementation {

	private readonly _webExtractorService: WebExtractorService;
	private readonly _highRagService: HighRagService;
	private readonly _orchestrator: IDEExecutionOrchestrator;
	private readonly _specEngine: KiroSpecEngine;

	constructor(
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@ILanguageModelToolsService private readonly _languageModelToolsService: ILanguageModelToolsService,
		@IRequestService private readonly _requestService: IRequestService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._webExtractorService = new WebExtractorService(this._requestService);
		const ollamaClient = new OllamaClient();
		const embeddingClient = new EmbeddingClient(ollamaClient);
		this._highRagService = new HighRagService(embeddingClient);
		this._orchestrator = instantiationService.createInstance(IDEExecutionOrchestrator);
		this._specEngine = instantiationService.createInstance(KiroSpecEngine);
	}

	async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		history: IChatAgentHistoryEntry[],
		token: CancellationToken
	): Promise<IChatAgentResult> {
		const ollamaModelIds = await this._languageModelsService.selectLanguageModels({ vendor: 'ollama' });

		if (ollamaModelIds.length === 0) {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(
					'### 🔴 No Ollama Models Available\n\n' +
					'OFCode could not find any models from the local Ollama server (`http://localhost:11434`).\n\n' +
					'**Quick Setup:**\n' +
					'1. Click **$(error) Ollama: Offline** in the status bar or run command `ofcode.ollama.startServer`.\n' +
					'2. Pull a model from the Control Center (e.g. `qwen2.5-coder:7b`, `llama3.2:3b`, `qwen3:14b`).\n\n' +
					'Once a model is downloaded, send your message again!'
				)
			}]);
			return {};
		}

		let targetModelId = ollamaModelIds[0];
		const userSelectedModel = request.userSelectedModelId;
		if (userSelectedModel) {
			const matched = ollamaModelIds.find(id =>
				id === userSelectedModel ||
				id.replace('ollama/', 'ollama:') === userSelectedModel ||
				id.replace('ollama:', 'ollama/') === userSelectedModel ||
				id.replace(/^ollama[:/]/, '') === userSelectedModel.replace(/^ollama[:/]/, '')
			);
			if (matched) {
				targetModelId = matched;
			} else {
				targetModelId = ollamaModelIds[0];
			}
		}

		// =========================================================================
		// Handle /spec command — Kiro Spec-Driven Development
		// =========================================================================
		if (request.command === 'spec') {
			const idea = request.message.replace(/^\/spec\s*/i, '').trim() || request.message;
			await this._specEngine.runSpec(
				idea,
				targetModelId,
				this._orchestrator,
				this._webExtractorService,
				this._highRagService,
				progress,
				token,
			);
			return {};
		}

		// =========================================================================
		// Handle /vibe command — Fast direct execution mode
		// =========================================================================
		if (request.command === 'vibe') {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(`> ⚡ **Vibe Mode:** Direct execution — skipping spec generation\n\n`)
			}]);
			// Fall through to normal execution with a note
		}

		// =========================================================================
		// Handle /web command — Force web search
		// =========================================================================
		if (request.command === 'web') {
			const query = request.message.replace(/^\/web\s*/i, '').trim() || request.message;
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(`> 🔍 **Web Search:** \`${query}\`...\n\n`)
			}]);
			try {
				const searchResults = await this._webExtractorService.searchAndExtract(query, 3, 3000);
				if (searchResults.extractedMarkdown?.trim()) {
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(searchResults.extractedMarkdown)
					}]);
				}
			} catch (err) {
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`> ⚠️ Web search failed: ${err instanceof Error ? err.message : String(err)}\n\n`)
				}]);
			}
			return {};
		}

		// =========================================================================
		// Handle /cmd command — Direct terminal execution
		// =========================================================================
		if (request.command === 'cmd') {
			const cmd = request.message.replace(/^\/cmd\s*/i, '').trim() || request.message;
			// Route through the runCommand tool
			const tool = this._languageModelToolsService.getTool('ofcode_runCommand');
			if (tool) {
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`> 🖥️ **Executing:** \`${cmd}\`\n\n`)
				}]);
				try {
					const toolResult = await this._languageModelToolsService.invokeTool(
						{
							callId: `cmd_${Date.now()}`,
							toolId: 'ofcode_runCommand',
							parameters: { command: cmd },
							context: { sessionResource: request.sessionResource }
						},
						async () => 0,
						token
					);
					if (toolResult?.content) {
						const resultText = toolResult.content.map(p => p.kind === 'text' ? p.value : '').join('\n');
						progress([{
							kind: 'markdownContent',
							content: new MarkdownString(resultText)
						}]);
					}
				} catch (err) {
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(`> ⚠️ Command failed: ${err instanceof Error ? err.message : String(err)}\n\n`)
					}]);
				}
			}
			return {};
		}

		const modelMetadata: ILanguageModelChatMetadata | undefined =
			this._languageModelsService.lookupLanguageModel(targetModelId) ??
			this._languageModelsService.lookupLanguageModel(ollamaModelIds[0]);

		// Collect registered tools and guarantee OFCode agent tools are always included
		const registeredTools = Array.from(this._languageModelToolsService.getTools(modelMetadata));
		for (const toolId of OFCODE_AGENT_TOOLS) {
			if (!registeredTools.some(t => t.id === toolId)) {
				const tool = this._languageModelToolsService.getTool(toolId);
				if (tool) {
					registeredTools.push(tool);
				}
			}
		}

		const requestTools = registeredTools.map(tool => ({
			type: 'function' as const,
			name: tool.id,
			description: tool.modelDescription || tool.userDescription || tool.displayName || tool.id,
			parameters: (tool.inputSchema as any) || { type: 'object', properties: {} }
		}));

		// Build system prompt with strict refusal override, agentic tool awareness, and IDE orchestrator instructions
		const messages: IChatMessage[] = [
			{
				role: ChatMessageRole.System,
				content: [{
					type: 'text',
					value: 'You are OFCode, a full-featured Agentic AI IDE (like Cursor, Windsurf, Kiro.dev, and AntiGravity) powered by Ollama.\n' +
						'You HAVE FULL ACCESS to external websites, live web scraping, GitHub, the local filesystem, AST High-RAG, and the integrated terminal ' +
						'through your built-in tools (`vscode_chromeExtract`, `vscode_highRag`, `vscode_githubExplore`, `ofcode_readFile`, `ofcode_writeFile`, `ofcode_editFile`, `ofcode_listFiles`, `ofcode_runCommand`).\n\n' +
						'THE OFCODE IDE HOST AUTOMATICALLY:\n' +
						'• Pre-fetches any URLs in the user prompt (content appears as [IDE Pre-Fetched Web Content])\n' +
						'• Scans the workspace file tree and injects relevant AST/RAG context\n' +
						'• Writes files you generate to disk when you use "// filepath: path" markers or <ofcode_file path="...">...</ofcode_file> XML blocks\n' +
						'• Executes terminal commands from <ofcode_cmd>command</ofcode_cmd> blocks\n' +
						'• Checks compiler/linter diagnostics after each file write and auto-loops to fix errors\n\n' +
						'CRITICAL OPERATING RULES:\n' +
						'1. NEVER say "I do not have access to external websites or the internet", "I cannot browse the web", or "I cannot access files". The IDE Host handles all of this for you.\n' +
						'2. When the user asks about an external URL or web topic, inspect the provided extracted content or immediately invoke `vscode_chromeExtract`.\n' +
						'3. When the user asks about codebase, files, functions, or project structure, invoke `ofcode_readFile`, `ofcode_listFiles`, or `vscode_highRag`.\n' +
						'4. When asked to write or edit code, use `ofcode_writeFile` / `ofcode_editFile` OR output files with "// filepath:" markers. The IDE will auto-apply both.\n' +
						'5. When asked to run commands, run tests, or execute scripts, use `ofcode_runCommand` OR output <ofcode_cmd>command</ofcode_cmd> blocks.\n' +
						'6. Tag every generated file block with `// filepath: relative/path/to/file.ext` so the IDE can auto-apply it.\n' +
						'7. Always be direct, concise, proactive, and helpful.'
				}]
			}
		];

		// Attach previous conversation history
		for (const entry of history) {
			if (entry.request?.message) {
				messages.push({
					role: ChatMessageRole.User,
					content: [{ type: 'text', value: entry.request.message }]
				});
			}

			const historyTextParts: string[] = [];
			for (const part of entry.response || []) {
				if (part && typeof part === 'object' && 'kind' in part && part.kind === 'markdownContent' && part.content) {
					historyTextParts.push(typeof part.content === 'string' ? part.content : part.content.value);
				}
			}

			if (historyTextParts.length > 0) {
				const fullAssistantResponse = historyTextParts.join('');
				// Filter out past refusal echoes so the local model does not repeat its own past refusal
				if (!fullAssistantResponse.includes("can't access external websites") && !fullAssistantResponse.includes("cannot access external websites")) {
					messages.push({
						role: ChatMessageRole.Assistant,
						content: [{ type: 'text', value: fullAssistantResponse }]
					});
				}
			}
		}

		// =========================================================================
		// Phase 1: IDE Orchestrator — Proactive Context Enrichment
		// =========================================================================
		let userPrompt = request.message;

		userPrompt = await this._orchestrator.enrichPrompt(
			userPrompt,
			this._webExtractorService,
			this._highRagService,
			progress,
			token,
		);

		// Handle /rag command explicitly
		if (request.command === 'rag') {
			try {
				const ragResult = await this._highRagService.search(userPrompt, 2000);
				if (ragResult.formattedContext) {
					userPrompt = `[High-RAG Code Context]:\n${ragResult.formattedContext}\n\n---\n\n${userPrompt}`;
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(`> 🧠 **High-RAG:** Injected ${ragResult.chunks.length} AST symbol definitions\n\n`)
					}]);
				}
			} catch {
				// Proceed gracefully
			}
		}

		// User current message and variable context
		if (request.variables && Object.keys(request.variables).length > 0) {
			const variableContexts: string[] = [];
			for (const [key, value] of Object.entries(request.variables)) {
				variableContexts.push(`[Context ${key}]: ${JSON.stringify(value)}`);
			}
			if (variableContexts.length > 0) {
				userPrompt = `${variableContexts.join('\n')}\n\n${userPrompt}`;
			}
		}

		messages.push({
			role: ChatMessageRole.User,
			content: [{ type: 'text', value: userPrompt }]
		});

		// =========================================================================
		// Agentic Loop: Execute native & inline tool calls up to 8 turns
		// with IDE Orchestrator auto-apply & self-healing diagnostics
		// =========================================================================
		const maxTurns = 8;
		for (let turn = 0; turn < maxTurns; turn++) {
			if (token.isCancellationRequested) {
				break;
			}

			let response;
			try {
				response = await this._languageModelsService.sendChatRequest(
					targetModelId,
					undefined,
					messages,
					{ tools: requestTools },
					token
				);
			} catch (err) {
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`\n\n[Ollama Request Error: ${err instanceof Error ? err.message : String(err)}]`)
				}]);
				break;
			}

			let currentTurnAssistantText = '';
			const toolUseParts: Array<{ name: string; toolCallId: string; parameters: Record<string, unknown> }> = [];

			for await (const chunkOrArray of response.stream) {
				if (token.isCancellationRequested) {
					break;
				}

				const chunks: IChatResponsePart[] = Array.isArray(chunkOrArray) ? chunkOrArray : [chunkOrArray];
				for (const chunk of chunks) {
					if (chunk.type === 'text') {
						currentTurnAssistantText += chunk.value;
						progress([{
							kind: 'markdownContent',
							content: new MarkdownString(chunk.value)
						}]);
					} else if (chunk.type === 'thinking') {
						const thinkingVal = Array.isArray(chunk.value) ? chunk.value.join('\n') : chunk.value;
						progress([{
							kind: 'thinking',
							value: thinkingVal
						}]);
					} else if (chunk.type === 'tool_use') {
						toolUseParts.push({
							name: chunk.name,
							toolCallId: chunk.toolCallId,
							parameters: chunk.parameters || {}
						});
					}
				}
			}

			// ─── Phase 2: IDE Orchestrator Auto-Apply ────────────────
			// Parse inline file/cmd blocks from the assistant's text response
			if (currentTurnAssistantText) {
				const execResult = await this._orchestrator.applyResponse(
					currentTurnAssistantText, progress, token
				);

				// ─── Phase 3: Self-Healing Diagnostics ───────────────
				if (execResult.filesWritten.length > 0) {
					let errors = await this._orchestrator.checkDiagnostics(
						execResult.filesWritten, progress
					);

					let healAttempt = 0;
					while (errors.length > 0 && healAttempt < this._orchestrator.maxSelfHealRetries) {
						healAttempt++;
						progress([{
							kind: 'markdownContent',
							content: new MarkdownString(`> 🔧 **IDE Self-Healing:** Auto-retry ${healAttempt}/${this._orchestrator.maxSelfHealRetries}...\n\n`)
						}]);

						const fixPrompt = this._orchestrator.buildSelfHealingPrompt(errors, healAttempt);
						messages.push({
							role: ChatMessageRole.User,
							content: [{ type: 'text', value: fixPrompt }]
						});

						// Get fix from Ollama
						try {
							const fixResponse = await this._languageModelsService.sendChatRequest(
								targetModelId, undefined, messages, { tools: requestTools }, token
							);
							let fixText = '';
							for await (const chunkOrArray of fixResponse.stream) {
								const chunks: IChatResponsePart[] = Array.isArray(chunkOrArray) ? chunkOrArray : [chunkOrArray];
								for (const chunk of chunks) {
									if (chunk.type === 'text') {
										fixText += chunk.value;
										progress([{ kind: 'markdownContent', content: new MarkdownString(chunk.value) }]);
									}
								}
							}
							const fixExecResult = await this._orchestrator.applyResponse(fixText, progress, token);
							if (fixExecResult.filesWritten.length > 0) {
								errors = await this._orchestrator.checkDiagnostics(fixExecResult.filesWritten, progress);
							} else {
								break;
							}
						} catch {
							break;
						}
					}
				}
			}

			// If no tools were yielded natively, parse markdown/text for inline tool calls
			if (toolUseParts.length === 0) {
				const fallbackCalls = ToolCallParser.parse(undefined, currentTurnAssistantText);
				if (fallbackCalls.length > 0) {
					for (let k = 0; k < fallbackCalls.length; k++) {
						toolUseParts.push({
							name: fallbackCalls[k].name,
							toolCallId: `inline_${Date.now()}_${k}`,
							parameters: fallbackCalls[k].parameters
						});
					}
				} else {
					// Assistant delivered its final response
					break;
				}
			}

			// Append the assistant tool_use message to history
			for (const call of toolUseParts) {
				messages.push({
					role: ChatMessageRole.Assistant,
					content: [{
						type: 'tool_use',
						name: call.name,
						toolCallId: call.toolCallId,
						parameters: call.parameters
					}]
				});
			}

			// Execute tool calls and append tool_result
			for (const call of toolUseParts) {
				if (token.isCancellationRequested) {
					break;
				}

				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`\n> ⚙️ **Running tool:** \`${call.name}\`...\n\n`)
				}]);

				const invocation: IToolInvocation = {
					callId: call.toolCallId,
					toolId: call.name,
					parameters: call.parameters,
					context: {
						sessionResource: request.sessionResource
					}
				};

				let toolResultText = '';
				try {
					const toolResult = await this._languageModelToolsService.invokeTool(
						invocation,
						async () => 0,
						token
					);

					if (toolResult && toolResult.content) {
						toolResultText = toolResult.content
							.map(part => (part.kind === 'text' ? part.value : ''))
							.join('\n');
					}

					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(`> ✅ Tool \`${call.name}\` finished.\n\n`)
					}]);
				} catch (toolErr) {
					toolResultText = `Tool Execution Error: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(`> ⚠️ Tool \`${call.name}\` failed: ${toolResultText}\n\n`)
					}]);
				}

				messages.push({
					role: ChatMessageRole.User,
					content: [{
						type: 'tool_result',
						toolCallId: call.toolCallId,
						value: [{
							type: 'text',
							value: toolResultText
						}]
					}]
				});
			}
		}

		return {};
	}
}

export class OfflineChatAgentContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chat.offlineChatAgent';

	constructor(
		@IChatAgentService chatAgentService: IChatAgentService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const agentData: IChatAgentData = {
			id: OFFLINE_AGENT_ID,
			name: 'OFCode',
			fullName: 'OFCode Kiro-Style Agentic IDE',
			description: 'Autonomous Agentic IDE with Spec-Driven Development, Self-Healing Diagnostics, and full IDE-Ollama symbiosis.',
			isDefault: true,
			isCore: true,
			locations: [
				ChatAgentLocation.Chat,
				ChatAgentLocation.EditorInline,
				ChatAgentLocation.Terminal,
				ChatAgentLocation.Notebook,
			],
			modes: [ChatModeKind.Agent, ChatModeKind.Ask, ChatModeKind.Edit],
			slashCommands: [
				{ name: 'spec', description: '📋 Spec Mode: Generate requirements, design, tasks & execute (Kiro-style)' },
				{ name: 'vibe', description: '⚡ Vibe Mode: Fast direct execution without spec generation' },
				{ name: 'rag', description: '🧠 Search codebase with AST High-RAG' },
				{ name: 'web', description: '🌐 Search & extract web docs' },
				{ name: 'cmd', description: '🖥️ Execute terminal commands directly' },
				{ name: 'github', description: '🐙 Explore GitHub repos & issues' },
				{ name: 'file', description: '📄 Read, write, or patch workspace files' },
				{ name: 'terminal', description: '💻 Execute shell commands in terminal' }
			],
			disambiguation: [],
			metadata: {},
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionDisplayName: nullExtensionDescription.name,
			extensionPublisherId: nullExtensionDescription.publisher,
		};

		this._register(chatAgentService.registerAgent(OFFLINE_AGENT_ID, agentData));

		const agentImpl = instantiationService.createInstance(OfflineChatAgent);
		this._register(agentImpl);
		this._register(chatAgentService.registerAgentImplementation(OFFLINE_AGENT_ID, agentImpl));
	}
}
