/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISemanticCodeChunk } from './astChunker.js';

export class DependencyGraph {
	private readonly _symbolMap = new Map<string, ISemanticCodeChunk[]>();

	rebuild(chunks: ISemanticCodeChunk[]): void {
		this._symbolMap.clear();
		for (const chunk of chunks) {
			if (chunk.symbol) {
				const existing = this._symbolMap.get(chunk.symbol) || [];
				existing.push(chunk);
				this._symbolMap.set(chunk.symbol, existing);
			}
		}
	}

	resolveDependencies(seedChunks: ISemanticCodeChunk[], maxTokens: number): ISemanticCodeChunk[] {
		const visitedIds = new Set<string>();
		const result: ISemanticCodeChunk[] = [];
		let currentTokens = 0;

		// 1. Add seed chunks first
		for (const seed of seedChunks) {
			if (!visitedIds.has(seed.id)) {
				visitedIds.add(seed.id);
				result.push(seed);
				currentTokens += seed.tokenCount;
			}
		}

		// 2. Expand dependencies level 1
		for (const seed of seedChunks) {
			for (const dep of seed.dependencies) {
				const matches = this._symbolMap.get(dep);
				if (matches) {
					for (const depChunk of matches) {
						if (!visitedIds.has(depChunk.id)) {
							if (currentTokens + depChunk.tokenCount <= maxTokens) {
								visitedIds.add(depChunk.id);
								result.push(depChunk);
								currentTokens += depChunk.tokenCount;
							}
						}
					}
				}
			}
		}

		return result;
	}
}
