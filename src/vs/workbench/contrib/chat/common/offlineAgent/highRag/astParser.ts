/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IASTNode {
	readonly name: string;
	readonly kind: 'function' | 'class' | 'interface' | 'type' | 'import' | 'export';
	readonly startLine: number;
	readonly endLine: number;
	readonly content: string;
	readonly dependencies: string[];
}

export class ASTParser {
	/**
	 * Parses TypeScript / JavaScript code into semantic AST chunks.
	 * Extracts functions, classes, interfaces, types, and their referenced symbols.
	 */
	static parse(content: string, filename: string): IASTNode[] {
		const nodes: IASTNode[] = [];
		const lines = content.split('\n');

		// 1. Extract imports and their imported identifiers
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line.startsWith('import ') || line.startsWith('import type ')) {
				const startLine = i + 1;
				let importBlock = line;
				while (!importBlock.includes(';') && !importBlock.includes('from') && i + 1 < lines.length) {
					i++;
					importBlock += ' ' + lines[i].trim();
				}
				const importedSymbols = this._extractImportedSymbols(importBlock);
				nodes.push({
					name: importedSymbols.join(', ') || 'import',
					kind: 'import',
					startLine,
					endLine: i + 1,
					content: importBlock,
					dependencies: importedSymbols
				});
			}
		}

		// 2. Extract function, class, and interface blocks
		const declRegex = /(?:export\s+)?(?:async\s+)?(?:function\s+([a-zA-Z0-9_$]+)|class\s+([a-zA-Z0-9_$]+)|interface\s+([a-zA-Z0-9_$]+)|type\s+([a-zA-Z0-9_$]+))/g;
		let match: RegExpExecArray | null;

		while ((match = declRegex.exec(content)) !== null) {
			const name = match[1] || match[2] || match[3] || match[4];
			const kind = match[1] ? 'function' : match[2] ? 'class' : match[3] ? 'interface' : 'type';
			const startPos = match.index;

			const startLine = content.slice(0, startPos).split('\n').length;
			const { endLine, blockContent } = this._extractBalancedBlock(lines, startLine - 1);

			// Extract symbols used in this block
			const dependencies = this._extractReferencedSymbols(blockContent, name);

			nodes.push({
				name,
				kind,
				startLine,
				endLine,
				content: blockContent,
				dependencies
			});
		}

		return nodes;
	}

	private static _extractBalancedBlock(lines: string[], startIdx: number): { endLine: number; blockContent: string } {
		let braceCount = 0;
		let started = false;
		let endIdx = startIdx;
		const blockLines: string[] = [];

		for (let i = startIdx; i < lines.length; i++) {
			const line = lines[i];
			blockLines.push(line);

			for (const ch of line) {
				if (ch === '{') {
					braceCount++;
					started = true;
				} else if (ch === '}') {
					braceCount--;
				}
			}

			if (started && braceCount <= 0) {
				endIdx = i;
				break;
			}

			// If it's a type alias without braces ending with a semicolon
			if (!started && line.includes(';')) {
				endIdx = i;
				break;
			}
		}

		return {
			endLine: endIdx + 1,
			blockContent: blockLines.join('\n')
		};
	}

	private static _extractImportedSymbols(importStmt: string): string[] {
		const match = importStmt.match(/\{([\s\S]*?)\}/);
		if (match) {
			return match[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
		}
		const defaultMatch = importStmt.match(/import\s+([a-zA-Z0-9_$]+)\s+from/);
		if (defaultMatch) {
			return [defaultMatch[1]];
		}
		return [];
	}

	private static _extractReferencedSymbols(code: string, selfName: string): string[] {
		const wordMatches = code.match(/[A-Z][a-zA-Z0-9_$]*/g) || [];
		const unique = new Set<string>();
		for (const w of wordMatches) {
			if (w !== selfName && w.length > 2) {
				unique.add(w);
			}
		}
		return Array.from(unique);
	}
}
