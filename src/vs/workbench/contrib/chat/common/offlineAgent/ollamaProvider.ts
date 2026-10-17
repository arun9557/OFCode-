/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import {
	IChatMessage,
	ILanguageModelChatInfoOptions,
	ILanguageModelChatMetadata,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
	ILanguageModelsService,
	IChatResponsePart,
} from '../languageModels.js';
import { OllamaClient, IOllamaChatMessage, IOllamaToolDefinition } from './ollamaClient.js';
import { OllamaRouter, IRoutedModelInfo } from './ollamaRouter.js';
import { ToolCallParser } from './toolCallParser.js';
import { estimateTokenCount } from './tokenBudget.js';

export class OllamaLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _client: OllamaClient;
	private readonly _router: OllamaRouter;

	constructor() {
		super();
		this._client = new OllamaClient();
		this._router = new OllamaRouter(this._client);
	}

	async provideLanguageModelChatInfo(options: ILanguageModelChatInfoOptions, token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const routedModels = await this._router.refreshModels();
		const results: ILanguageModelChatMetadataAndIdentifier[] = [];

		for (const routed of routedModels) {
			const tag = routed.tag;
			const modelId = `ollama/${tag.name}`;

			const metadata: ILanguageModelChatMetadata = {
				id: modelId,
				name: tag.name,
				vendor: 'ollama',
				family: tag.details?.family || 'ollama',
				version: tag.details?.quantization_level || 'q4_k_m',
				maxInputTokens: routed.optimalContextLength - routed.budget.generationReserve,
				maxOutputTokens: routed.budget.generationReserve,
				maxContextWindowTokens: routed.optimalContextLength,
				isBYOK: true,
				isDefaultForLocation: {},
				extension: new ExtensionIdentifier('vscode.offline-agent'),
				capabilities: {
					toolCalling: routed.supportsTools,
					agentMode: routed.supportsTools,
					vision: false,
				}
			};

			results.push({
				identifier: modelId,
				metadata
			});
		}

		return results;
	}

	async sendChatRequest(
		modelId: string,
		messages: IChatMessage[],
		from: ExtensionIdentifier | undefined,
		options: ILanguageModelChatRequestOptions,
		token: CancellationToken
	): Promise<ILanguageModelChatResponse> {
		const rawModelName = modelId.replace(/^ollama\//, '');
		const ollamaMessages: IOllamaChatMessage[] = [];

		for (const msg of messages) {
			let text = '';
			for (const part of msg.content) {
				if (part.type === 'text') {
					text += part.value;
				} else if (part.type === 'tool_result') {
					text += `\n[Tool Result: ${part.toolCallId}]\n` + part.value.map(v => 'value' in v ? v.value : '').join('\n');
				}
			}
			const role = msg.role === 0 ? 'system' : msg.role === 1 ? 'user' : 'assistant';
			ollamaMessages.push({ role, content: text });
		}

		// Convert tools if provided in options
		let toolDefs: IOllamaToolDefinition[] | undefined;
		if (Array.isArray(options.tools)) {
			toolDefs = options.tools.map(t => ({
				type: 'function',
				function: {
					name: t.name || t.id,
					description: t.description || t.modelDescription || '',
					parameters: t.inputSchema || { type: 'object', properties: {} }
				}
			}));
		}

		const streamGenerator = this._streamChat(rawModelName, ollamaMessages, toolDefs, token);

		return {
			stream: streamGenerator,
			result: Promise.resolve({})
		};
	}

	private async *_streamChat(
		model: string,
		messages: IOllamaChatMessage[],
		tools: IOllamaToolDefinition[] | undefined,
		token: CancellationToken
	): AsyncGenerator<IChatResponsePart, void, unknown> {
		const abortController = new AbortController();
		token.onCancellationRequested(() => abortController.abort());

		let fullAssistantText = '';

		try {
			const stream = this._client.chatStream({
				model,
				messages,
				tools,
				options: {
					temperature: 0.2,
				}
			}, abortController.signal);

			for await (const chunk of stream) {
				if (token.isCancellationRequested) {
					break;
				}

				if (chunk.message?.content) {
					fullAssistantText += chunk.message.content;
					yield {
						type: 'text',
						value: chunk.message.content
					};
				}

				// Check for native Ollama tool calls
				if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
					for (let i = 0; i < chunk.message.tool_calls.length; i++) {
						const call = chunk.message.tool_calls[i];
						yield {
							type: 'tool_use',
							name: call.function.name,
							toolCallId: `call_${Date.now()}_${i}`,
							parameters: call.function.arguments || {}
						};
					}
				}
			}

			// Fallback parsing if small model emitted tool calls in markdown/text
			const parsedCalls = ToolCallParser.parse(undefined, fullAssistantText);
			for (let j = 0; j < parsedCalls.length; j++) {
				const fallbackCall = parsedCalls[j];
				yield {
					type: 'tool_use',
					name: fallbackCall.name,
					toolCallId: `fallback_${Date.now()}_${j}`,
					parameters: fallbackCall.parameters
				};
			}
		} catch (err) {
			if (!token.isCancellationRequested) {
				yield {
					type: 'text',
					value: `\n\n[Ollama Connection Error: ${err}]`
				};
			}
		}
	}

	async provideTokenCount(modelId: string, message: string | IChatMessage, token: CancellationToken): Promise<number> {
		if (typeof message === 'string') {
			return estimateTokenCount(message);
		}
		let text = '';
		for (const part of message.content) {
			if (part.type === 'text') {
				text += part.value;
			}
		}
		return estimateTokenCount(text);
	}
}

export class OllamaProviderContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chat.ollamaProvider';

	constructor(
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const provider = instantiationService.createInstance(OllamaLanguageModelProvider);
		this._register(languageModelsService.registerLanguageModelProvider('ollama', provider));
	}
}
