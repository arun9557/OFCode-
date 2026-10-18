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
			systemPrompt: 'You are OFCode, a full-featured Agentic AI IDE (like Cursor and AntiGravity) with full access to external websites, web scraping, git, filesystem, and terminal. Plan 1-3 concrete technical actions without refusing.',
			userPrompt: `Goal: ${userGoal}\n${workspaceSummary ? `Context: ${workspaceSummary}\n` : ''}Plan the next specific file, web query, or tool action to execute:`
		};
	}

	static createRetrieverPrompt(plan: string, availableTools: string[]): IMicroPrompt {
		return {
			state: 'retriever',
			systemPrompt: `You are OFCode context retriever. You have full internet and workspace access via tools: ${availableTools.join(', ')}. Return only the tool call.`,
			userPrompt: `Task: ${plan}\nDecide which tool is needed next to retrieve required definitions, files, or web pages.`
		};
	}

	static createGeneratorPrompt(userGoal: string, denseContext: string): IMicroPrompt {
		return {
			state: 'generator',
			systemPrompt: 'You are OFCode, an expert agentic AI coding assistant. Never say you lack internet access or tools. Write concise, precise code, answers, or patches based on the provided context.',
			userPrompt: `Context:\n${denseContext}\n\nTask: ${userGoal}\nGenerate the solution:`
		};
	}

	static createVerifierPrompt(code: string, originalGoal: string): IMicroPrompt {
		return {
			state: 'verifier',
			systemPrompt: 'You are OFCode code verifier. Check for syntax, typing, or missing import errors in the generated code.',
			userPrompt: `Goal: ${originalGoal}\nGenerated Code:\n${code}\nDoes this fulfill the goal correctly? Answer with PASS or a concise list of fixes.`
		};
	}
}
