/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ITokenBudgetConfig {
	readonly maxContextWindow: number;
	readonly systemPromptBudget: number;
	readonly ragBudget: number;
	readonly toolResultBudget: number;
	readonly generationReserve: number;
}

export const SMALL_MODEL_BUDGET: ITokenBudgetConfig = {
	maxContextWindow: 8192,
	systemPromptBudget: 400,
	ragBudget: 1500,
	toolResultBudget: 1000,
	generationReserve: 1024,
};

export const MEDIUM_MODEL_BUDGET: ITokenBudgetConfig = {
	maxContextWindow: 16384,
	systemPromptBudget: 800,
	ragBudget: 3500,
	toolResultBudget: 2000,
	generationReserve: 2048,
};

export const LARGE_MODEL_BUDGET: ITokenBudgetConfig = {
	maxContextWindow: 32768,
	systemPromptBudget: 1500,
	ragBudget: 8000,
	toolResultBudget: 4000,
	generationReserve: 4096,
};

export function estimateTokenCount(text: string): number {
	if (!text) {
		return 0;
	}
	// Fast rule of thumb for English and source code: ~3.5 chars per token
	return Math.ceil(text.length / 3.5);
}

export function truncateToTokenBudget(text: string, budgetTokens: number): string {
	const currentTokens = estimateTokenCount(text);
	if (currentTokens <= budgetTokens) {
		return text;
	}
	const targetCharCount = Math.floor(budgetTokens * 3.5);
	return text.slice(0, targetCharCount) + '\n\n... [Content truncated to fit small model context budget]';
}
