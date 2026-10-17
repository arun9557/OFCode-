/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OllamaClient } from '../ollamaClient.js';

export class EmbeddingClient {
	private readonly _client: OllamaClient;
	private readonly _model: string;
	private readonly _cache = new Map<string, number[]>();

	constructor(client: OllamaClient, model: string = 'nomic-embed-text') {
		this._client = client;
		this._model = model;
	}

	async getEmbedding(text: string): Promise<number[]> {
		const cached = this._cache.get(text);
		if (cached) {
			return cached;
		}

		const embeddings = await this._client.generateEmbeddings(this._model, text);
		const vector = embeddings[0] || [];
		this._cache.set(text, vector);
		return vector;
	}

	async getEmbeddingsBatch(texts: string[]): Promise<number[][]> {
		const results: number[][] = [];
		const toFetch: { index: number; text: string }[] = [];

		for (let i = 0; i < texts.length; i++) {
			const cached = this._cache.get(texts[i]);
			if (cached) {
				results[i] = cached;
			} else {
				toFetch.push({ index: i, text: texts[i] });
			}
		}

		if (toFetch.length > 0) {
			const batchTexts = toFetch.map(item => item.text);
			try {
				const batchEmbeddings = await this._client.generateEmbeddings(this._model, batchTexts);
				for (let j = 0; j < toFetch.length; j++) {
					const vector = batchEmbeddings[j] || [];
					this._cache.set(toFetch[j].text, vector);
					results[toFetch[j].index] = vector;
				}
			} catch {
				// Fallback to one-by-one
				for (const item of toFetch) {
					try {
						const vec = await this.getEmbedding(item.text);
						results[item.index] = vec;
					} catch {
						results[item.index] = [];
					}
				}
			}
		}

		return results;
	}
}
