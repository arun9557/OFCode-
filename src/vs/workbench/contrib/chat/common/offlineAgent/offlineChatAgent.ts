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

	constructor(
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@ILanguageModelToolsService private readonly _languageModelToolsService: ILanguageModelToolsService,
		@IRequestService private readonly _requestService: IRequestService,
	) {
		super();
		this._webExtractorService = new WebExtractorService(this._requestService);
		const ollamaClient = new OllamaClient();
		const embeddingClient = new EmbeddingClient(ollamaClient);
		this._highRagService = new HighRagService(embeddingClient);
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

		// Build system prompt with strict refusal override & agentic tool awareness
		const messages: IChatMessage[] = [
			{
				role: ChatMessageRole.System,
				content: [{
					type: 'text',
					value: 'You are OFCode, a full-featured Agentic AI IDE (like Cursor, Windsurf, and AntiGravity) powered by Ollama.\n' +
						'You HAVE FULL ACCESS to external websites, live web scraping, GitHub, the local filesystem, AST High-RAG, and the integrated terminal ' +
						'through your built-in tools (`vscode_chromeExtract`, `vscode_highRag`, `vscode_githubExplore`, `ofcode_readFile`, `ofcode_writeFile`, `ofcode_editFile`, `ofcode_listFiles`, `ofcode_runCommand`).\n\n' +
						'CRITICAL OPERATING RULES:\n' +
						'1. NEVER say "I do not have access to external websites or the internet", "I cannot browse the web", or "I cannot access files". You have active tools for all of these.\n' +
						'2. When the user asks about an external URL or web topic, inspect the provided extracted content or immediately invoke `vscode_chromeExtract`.\n' +
						'3. When the user asks about codebase, files, functions, or project structure, invoke `ofcode_readFile`, `ofcode_listFiles`, or `vscode_highRag`.\n' +
						'4. When asked to write or edit code, invoke `ofcode_writeFile` or `ofcode_editFile`.\n' +
						'5. When asked to run commands, run tests, or execute scripts, invoke `ofcode_runCommand`.\n' +
						'6. Always be direct, concise, proactive, and helpful.'
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
		// Proactive Agentic Pre-Router (Auto-URL Scrape, Auto-Web Search, Auto-RAG)
		// =========================================================================
		let userPrompt = request.message;

		// 1. Auto URL Extraction: If user prompt contains http:// or https://, extract immediately
		const urlMatches = userPrompt.match(/https?:\/\/[^\s<>'")]+/gi);
		if (urlMatches && urlMatches.length > 0) {
			for (const url of urlMatches) {
				if (token.isCancellationRequested) {
					break;
				}
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`> 🌐 **Extracting web content from** \`${url}\`...\n\n`)
				}]);
				try {
					const extracted = await this._webExtractorService.extractUrl(url, 3500);
					if (extracted.extractedMarkdown && extracted.extractedMarkdown.trim().length > 0) {
						userPrompt = `[Extracted Web Content from ${url}]:\n${extracted.extractedMarkdown}\n\n[System Directive]: The contents of ${url} have been extracted and provided above. Do not claim you cannot access the link. Answer the user request directly using this extracted content.\n\n---\n\n${userPrompt}`;
						progress([{
							kind: 'markdownContent',
							content: new MarkdownString(`> ✅ Extracted clean content (${extracted.extractedMarkdown.length} characters) from \`${url}\`\n\n`)
						}]);
					}
				} catch (urlErr) {
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(`> ⚠️ Failed to auto-extract \`${url}\`: ${urlErr instanceof Error ? urlErr.message : String(urlErr)}\n\n`)
					}]);
				}
			}
		}

		// 2. Auto Web Search: If user asks to search the web, fetch latest docs, or query online
		const searchTrigger = /(?:search\s+(?:the\s+)?web|search\s+online|latest\s+docs|chrome\s+se\s+nikaalo|search\s+google|google\s+search)/i;
		if (searchTrigger.test(userPrompt) && (!urlMatches || urlMatches.length === 0)) {
			const cleanQuery = userPrompt.replace(searchTrigger, '').trim() || userPrompt;
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(`> 🔍 **Searching the web:** \`${cleanQuery}\`...\n\n`)
			}]);
			try {
				const searchResults = await this._webExtractorService.searchAndExtract(cleanQuery, 2, 2500);
				if (searchResults.extractedMarkdown && searchResults.extractedMarkdown.trim().length > 0) {
					userPrompt = `[Web Search Results for "${cleanQuery}"]:\n${searchResults.extractedMarkdown}\n\n---\n\n${userPrompt}`;
					progress([{
						kind: 'markdownContent',
						content: new MarkdownString(`> ✅ Retrieved top web results for \`${cleanQuery}\`\n\n`)
					}]);
				}
			} catch (searchErr) {
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`> ⚠️ Web search query failed: ${searchErr instanceof Error ? searchErr.message : String(searchErr)}\n\n`)
				}]);
			}
		}

		// 3. Auto Codebase Context: If user asks about AST High-RAG, call graph, or symbols
		if (/\b(high-rag|ast|call graph|symbol lookup)\b/i.test(userPrompt) || request.command === 'rag') {
			try {
				const ragResult = await this._highRagService.search(userPrompt, 1500);
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
			fullName: 'OFCode Local AI Agent',
			description: '100% Offline Agentic Coding Assistant powered by Ollama',
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
				{ name: 'rag', description: 'Search codebase with AST High-RAG' },
				{ name: 'web', description: 'Search & extract web docs' },
				{ name: 'github', description: 'Explore GitHub repos & issues' },
				{ name: 'file', description: 'Read, write, or patch workspace files' },
				{ name: 'terminal', description: 'Execute shell commands in terminal' }
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
