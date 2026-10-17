/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ChatAgentLocation } from '../constants.js';
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
	IUserFriendlyLanguageModel,
} from '../languageModels.js';
import { ILanguageModelsConfigurationService } from '../languageModelsConfiguration.js';
import { OllamaClient, IOllamaChatMessage, IOllamaToolDefinition } from './ollamaClient.js';
import { OllamaRouter } from './ollamaRouter.js';
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

		for (let index = 0; index < routedModels.length; index++) {
			const routed = routedModels[index];
			const tag = routed.tag;
			const modelId = `ollama/${tag.name}`;
			const isFirstModel = index === 0;

			const nameLower = tag.name.toLowerCase();
			const isVisionModel = nameLower.includes('vision') || nameLower.includes('llava') || nameLower.includes('moondream');

			const metadata: ILanguageModelChatMetadata = {
				id: modelId,
				name: tag.name,
				vendor: 'ollama',
				family: tag.details?.family || 'ollama',
				version: tag.details?.quantization_level || 'q4_k_m',
				maxInputTokens: 16384,
				maxOutputTokens: 4096,
				maxContextWindowTokens: routed.optimalContextLength || 16384,
				isBYOK: true,
				isUserSelectable: true,
				isDefaultForLocation: {
					[ChatAgentLocation.Chat]: isFirstModel,
					[ChatAgentLocation.Terminal]: isFirstModel,
					[ChatAgentLocation.EditorInline]: isFirstModel
				},
				extension: new ExtensionIdentifier('vscode.offline-agent'),
				capabilities: {
					toolCalling: true,
					agentMode: true,
					vision: isVisionModel,
					editTools: ['vscode_editFile_internal']
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
		const rawModelName = modelId.replace(/^ollama[:/]/, '');
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

	private readonly _ollamaVendorDescriptor: IUserFriendlyLanguageModel = {
		vendor: 'ollama',
		displayName: 'Ollama (Local)',
		configuration: undefined,
		managementCommand: undefined,
		when: undefined
	} as unknown as IUserFriendlyLanguageModel;

	constructor(
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@ILanguageModelsConfigurationService languageModelsConfigService: ILanguageModelsConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		// Register vendor descriptor so model picker shows an 'Ollama' tab
		languageModelsService.deltaLanguageModelChatProviderDescriptors([this._ollamaVendorDescriptor], []);
		this._register(toDisposable(() => {
			languageModelsService.deltaLanguageModelChatProviderDescriptors([], [this._ollamaVendorDescriptor]);
		}));

		// Register provider
		const provider = instantiationService.createInstance(OllamaLanguageModelProvider);
		this._register(languageModelsService.registerLanguageModelProvider('ollama', provider));

		// Ensure an 'ollama' provider group exists so hasByokModels=true bypasses the Copilot gate
		languageModelsConfigService.whenReady.then(() => {
			if (this._store.isDisposed) {
				return;
			}
			const existingGroups = languageModelsConfigService.getLanguageModelsProviderGroups();
			const hasOllamaGroup = existingGroups.some(g => g.vendor === 'ollama');
			if (!hasOllamaGroup) {
				languageModelsConfigService.addLanguageModelsProviderGroup({
					name: 'Ollama (Local)',
					vendor: 'ollama',
					url: 'http://localhost:11434'
				}).catch(() => { /* ignore */ });
			}
		});

		// Eager discovery and background retries
		const triggerDiscovery = () => {
			if (!this._store.isDisposed) {
				languageModelsService.selectLanguageModels({ vendor: 'ollama' }).catch(() => { /* ignore */ });
			}
		};

		triggerDiscovery();
		const timer1 = setTimeout(triggerDiscovery, 1500);
		const timer2 = setTimeout(triggerDiscovery, 5000);
		const interval = setInterval(triggerDiscovery, 30000);

		this._register(toDisposable(() => {
			clearTimeout(timer1);
			clearTimeout(timer2);
			clearInterval(interval);
		}));
	}
}
