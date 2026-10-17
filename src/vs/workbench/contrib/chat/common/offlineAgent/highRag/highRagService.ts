/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ASTParser } from './astParser.js';
import { ASTChunker, ISemanticCodeChunk } from './astChunker.js';
import { EmbeddingClient } from './embeddingClient.js';
import { VectorStore } from './vectorStore.js';
import { DependencyGraph } from './dependencyGraph.js';

export interface IHighRagQueryResult {
	readonly chunks: ISemanticCodeChunk[];
	readonly totalTokens: number;
	readonly formattedContext: string;
}

export class HighRagService {
	private readonly _vectorStore: VectorStore;
	private readonly _embeddingClient: EmbeddingClient;
	private readonly _dependencyGraph: DependencyGraph;

	constructor(embeddingClient: EmbeddingClient) {
		this._vectorStore = new VectorStore();
		this._embeddingClient = embeddingClient;
		this._dependencyGraph = new DependencyGraph();
	}

	async indexFile(filename: string, content: string): Promise<number> {
		const nodes = ASTParser.parse(content, filename);
		const chunks = ASTChunker.createChunks(filename, nodes);

		if (chunks.length === 0) {
			return 0;
		}

		// Embed chunks
		const texts = chunks.map(c => `${c.kind} ${c.symbol} in ${c.filename}:\n${c.code}`);
		const embeddings = await this._embeddingClient.getEmbeddingsBatch(texts);

		for (let i = 0; i < chunks.length; i++) {
			chunks[i].embedding = embeddings[i];
		}

		this._vectorStore.addChunks(chunks);
		this._dependencyGraph.rebuild(this._vectorStore.allChunks);
		return chunks.length;
	}

	async search(query: string, maxTokens: number = 2000, topK: number = 5): Promise<IHighRagQueryResult> {
		const queryEmbedding = await this._embeddingClient.getEmbedding(query);
		const searchResults = this._vectorStore.search(queryEmbedding, topK);

		const seedChunks = searchResults.map(r => r.chunk);
		const resolvedChunks = this._dependencyGraph.resolveDependencies(seedChunks, maxTokens);

		let totalTokens = 0;
		const formattedParts: string[] = [];

		for (const chunk of resolvedChunks) {
			totalTokens += chunk.tokenCount;
			formattedParts.push(`// --- [${chunk.kind}] ${chunk.symbol} (${chunk.filename}:${chunk.startLine}-${chunk.endLine}) ---\n${chunk.code}`);
		}

		return {
			chunks: resolvedChunks,
			totalTokens,
			formattedContext: formattedParts.join('\n\n')
		};
	}
}
