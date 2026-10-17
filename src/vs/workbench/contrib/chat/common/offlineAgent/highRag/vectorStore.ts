/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISemanticCodeChunk } from './astChunker.js';

export interface IVectorSearchResult {
	readonly chunk: ISemanticCodeChunk;
	readonly score: number;
}

export class VectorStore {
	private _chunks: ISemanticCodeChunk[] = [];

	addChunks(chunks: ISemanticCodeChunk[]): void {
		// Filter out duplicate or updated IDs
		const ids = new Set(chunks.map(c => c.id));
		this._chunks = this._chunks.filter(c => !ids.has(c.id));
		this._chunks.push(...chunks);
	}

	clear(): void {
		this._chunks = [];
	}

	get allChunks(): ISemanticCodeChunk[] {
		return this._chunks;
	}

	search(queryEmbedding: number[], topK: number = 5): IVectorSearchResult[] {
		if (queryEmbedding.length === 0 || this._chunks.length === 0) {
			return [];
		}

		const scored: IVectorSearchResult[] = [];

		for (const chunk of this._chunks) {
			if (!chunk.embedding || chunk.embedding.length === 0) {
				continue;
			}
			const score = this._cosineSimilarity(queryEmbedding, chunk.embedding);
			scored.push({ chunk, score });
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, topK);
	}

	private _cosineSimilarity(vecA: number[], vecB: number[]): number {
		let dot = 0;
		let normA = 0;
		let normB = 0;
		const len = Math.min(vecA.length, vecB.length);

		for (let i = 0; i < len; i++) {
			dot += vecA[i] * vecB[i];
			normA += vecA[i] * vecA[i];
			normB += vecB[i] * vecB[i];
		}

		if (normA === 0 || normB === 0) {
			return 0;
		}
		return dot / (Math.sqrt(normA) * Math.sqrt(normB));
	}
}
