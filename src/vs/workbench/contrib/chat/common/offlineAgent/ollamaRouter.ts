/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IOllamaModelTag, OllamaClient } from './ollamaClient.js';
import { ITokenBudgetConfig, SMALL_MODEL_BUDGET, MEDIUM_MODEL_BUDGET, LARGE_MODEL_BUDGET } from './tokenBudget.js';

export type ModelTier = 'small' | 'medium' | 'large';

export interface IRoutedModelInfo {
	readonly tag: IOllamaModelTag;
	readonly tier: ModelTier;
	readonly supportsTools: boolean;
	readonly budget: ITokenBudgetConfig;
	readonly optimalContextLength: number;
}

export class OllamaRouter {
	private readonly _client: OllamaClient;
	private _cachedModels: IRoutedModelInfo[] = [];
	private _lastFetchTime = 0;

	constructor(client: OllamaClient) {
		this._client = client;
	}

	get client(): OllamaClient {
		return this._client;
	}

	async refreshModels(force: boolean = false): Promise<IRoutedModelInfo[]> {
		const now = Date.now();
		if (!force && this._cachedModels.length > 0 && now - this._lastFetchTime < 30000) {
			return this._cachedModels;
		}

		try {
			const rawModels = await this._client.listModels();
			const routed: IRoutedModelInfo[] = [];

			for (const model of rawModels) {
				const info = this._classifyModel(model);
				routed.push(info);
			}

			this._cachedModels = routed;
			this._lastFetchTime = now;
			return routed;
		} catch (err) {
			console.error('Failed to query local Ollama models:', err);
			return this._cachedModels;
		}
	}

	private _classifyModel(model: IOllamaModelTag): IRoutedModelInfo {
		const name = model.name.toLowerCase();
		const paramSize = model.details?.parameter_size?.toLowerCase() || '';

		let tier: ModelTier = 'medium';
		let optimalContextLength = 16384;
		let budget = MEDIUM_MODEL_BUDGET;

		if (paramSize.includes('1b') || paramSize.includes('2b') || paramSize.includes('3b') || name.includes(':3b') || name.includes(':1.5b') || name.includes(':0.5b')) {
			tier = 'small';
			optimalContextLength = 8192;
			budget = SMALL_MODEL_BUDGET;
		} else if (paramSize.includes('14b') || paramSize.includes('32b') || paramSize.includes('70b') || name.includes(':14b') || name.includes(':32b') || name.includes(':70b')) {
			tier = 'large';
			optimalContextLength = 32768;
			budget = LARGE_MODEL_BUDGET;
		}

		// Tool calling check: Qwen 2.5 coder, Llama 3.1/3.2, Mistral, Command-R generally support tool calling
		const supportsTools = name.includes('qwen2.5') ||
			name.includes('llama3.1') ||
			name.includes('llama3.2') ||
			name.includes('mistral') ||
			name.includes('command-r') ||
			tier === 'large';

		return {
			tag: model,
			tier,
			supportsTools,
			budget,
			optimalContextLength
		};
	}

	getFastAutocompleteModel(): IRoutedModelInfo | undefined {
		// Prefer 1.5B - 3B models for instantaneous completion
		const small = this._cachedModels.find(m => m.tier === 'small' && (m.tag.name.includes('coder') || m.tag.name.includes('qwen')));
		if (small) {
			return small;
		}
		return this._cachedModels.find(m => m.tier === 'small') || this._cachedModels[0];
	}

	getAgenticChatModel(): IRoutedModelInfo | undefined {
		// Prefer 7B - 14B Qwen2.5-Coder or Llama 3.1 with tool support
		const qwen14 = this._cachedModels.find(m => m.tag.name.includes('qwen2.5-coder:14b') || m.tag.name.includes('qwen2.5-coder:7b'));
		if (qwen14) {
			return qwen14;
		}
		const withTools = this._cachedModels.find(m => m.supportsTools && (m.tier === 'large' || m.tier === 'medium'));
		if (withTools) {
			return withTools;
		}
		return this._cachedModels.find(m => m.tier === 'large') || this._cachedModels[0];
	}

	getEmbeddingModel(): string {
		const found = this._cachedModels.find(m => m.tag.name.includes('embed') || m.tag.name.includes('nomic') || m.tag.name.includes('bge'));
		return found ? found.tag.name : 'nomic-embed-text';
	}
}
