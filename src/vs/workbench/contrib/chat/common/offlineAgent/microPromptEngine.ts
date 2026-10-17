/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type AgentMicroState = 'planner' | 'retriever' | 'generator' | 'verifier';

export interface IMicroPrompt {
	readonly state: AgentMicroState;
	readonly systemPrompt: string;
	readonly userPrompt: string;
}

export class MicroPromptEngine {
	static createPlannerPrompt(userGoal: string, workspaceSummary?: string): IMicroPrompt {
		return {
			state: 'planner',
			systemPrompt: 'You are an offline agent planner. Keep your answer under 100 words. Deconstruct the user request into 1-3 concrete technical actions.',
			userPrompt: `Goal: ${userGoal}\n${workspaceSummary ? `Context: ${workspaceSummary}\n` : ''}Plan the next specific file or action to query:`
		};
	}

	static createRetrieverPrompt(plan: string, availableTools: string[]): IMicroPrompt {
		return {
			state: 'retriever',
			systemPrompt: `You are an offline context retriever. Select exactly ONE tool to call: ${availableTools.join(', ')}. Return only the tool call.`,
			userPrompt: `Task: ${plan}\nDecide which tool is needed next to retrieve required definitions or information.`
		};
	}

	static createGeneratorPrompt(userGoal: string, denseContext: string): IMicroPrompt {
		return {
			state: 'generator',
			systemPrompt: 'You are an expert coder. Write only concise, precise code or patch changes based on the provided context.',
			userPrompt: `Context:\n${denseContext}\n\nTask: ${userGoal}\nGenerate the solution:`
		};
	}

	static createVerifierPrompt(code: string, originalGoal: string): IMicroPrompt {
		return {
			state: 'verifier',
			systemPrompt: 'You are a code verifier. Check for syntax, typing, or missing import errors in the generated code.',
			userPrompt: `Goal: ${originalGoal}\nGenerated Code:\n${code}\nDoes this fulfill the goal correctly? Answer with PASS or a concise list of fixes.`
		};
	}
}
