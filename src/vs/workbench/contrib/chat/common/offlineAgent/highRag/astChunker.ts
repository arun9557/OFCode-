/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IASTNode } from './astParser.js';
import { estimateTokenCount } from '../tokenBudget.js';

export interface ISemanticCodeChunk {
	readonly id: string;
	readonly filename: string;
	readonly symbol: string;
	readonly kind: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly code: string;
	readonly dependencies: string[];
	readonly tokenCount: number;
	embedding?: number[];
}

export class ASTChunker {
	static createChunks(filename: string, nodes: IASTNode[]): ISemanticCodeChunk[] {
		return nodes.map((node, index) => {
			const id = `${filename}#${node.name || 'node'}_${node.startLine}_${index}`;
			const tokenCount = estimateTokenCount(node.content);

			return {
				id,
				filename,
				symbol: node.name,
				kind: node.kind,
				startLine: node.startLine,
				endLine: node.endLine,
				code: node.content,
				dependencies: node.dependencies,
				tokenCount
			};
		});
	}
}
