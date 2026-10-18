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

export const OFFLINE_AGENT_ID = 'ofcode.offlineAgent';

export class OfflineChatAgent extends Disposable implements IChatAgentImplementation {

	constructor(
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@ILanguageModelToolsService private readonly _languageModelToolsService: ILanguageModelToolsService,
	) {
		super();
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
					'1. Ensure Ollama is installed from [ollama.com](https://ollama.com).\n' +
					'2. Start the local server: run `ollama serve` in a terminal.\n' +
					'3. Pull a model: run `ollama pull qwen2.5-coder:7b` (or `llama3.2`, `deepseek-r1`).\n\n' +
					'Once a model is downloaded, send a new message or switch models from the picker below.'
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
				// If the selected model is not found in installed models, fall back to first installed model
				targetModelId = ollamaModelIds[0];
			}
		}

		const modelMetadata: ILanguageModelChatMetadata | undefined = this._languageModelsService.lookupLanguageModel(targetModelId) ?? this._languageModelsService.lookupLanguageModel(ollamaModelIds[0]);

		// Collect registered tools
		const registeredTools = Array.from(this._languageModelToolsService.getTools(modelMetadata));
		const requestTools = registeredTools.map(tool => ({
			type: 'function' as const,
			name: tool.id,
			description: tool.modelDescription || tool.userDescription || tool.displayName || tool.id,
			parameters: tool.inputSchema || { type: 'object', properties: {} }
		}));

		// Build initial conversation messages
		const messages: IChatMessage[] = [
			{
				role: ChatMessageRole.System,
				content: [{
					type: 'text',
					value: 'You are OFCode, a helpful, precise, and offline AI coding assistant running directly on local Ollama models. ' +
						'You assist the developer with writing, analyzing, refactoring, and debugging code in their workspace. ' +
						'Be concise, clear, and direct. When relevant tools are available, invoke them to inspect files or search the workspace.'
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
				messages.push({
					role: ChatMessageRole.Assistant,
					content: [{ type: 'text', value: historyTextParts.join('') }]
				});
			}
		}

		// User current message and variable context
		let userPrompt = request.message;
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

		// Agentic loop: up to 8 turns
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

			// If no tools were called in this turn, the assistant has delivered its final response
			if (toolUseParts.length === 0) {
				break;
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
				} catch (toolErr) {
					toolResultText = `Tool Execution Error: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
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
				{ name: 'github', description: 'Explore GitHub repos & issues' }
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
