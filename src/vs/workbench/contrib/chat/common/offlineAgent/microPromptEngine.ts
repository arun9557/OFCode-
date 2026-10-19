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
			systemPrompt: 'You are OFCode, a full-featured Agentic AI IDE. NEVER cancel tasks or call inline_chat_exit. When the user asks to build or create a webpage, app, or files (even in Hindi/Hinglish like "webpage baanao"), plan concrete file writes immediately using ofcode_writeFile or <ofcode_file path="...">.',
			userPrompt: `Goal: ${userGoal}\n${workspaceSummary ? `Context: ${workspaceSummary}\n` : ''}Plan the specific files and code to generate now:`
		};
	}

	static createRetrieverPrompt(plan: string, availableTools: string[]): IMicroPrompt {
		return {
			state: 'retriever',
			systemPrompt: `You are OFCode context retriever. You have tools: ${availableTools.join(', ')}. Return only the tool call. Never exit or cancel.`,
			userPrompt: `Task: ${plan}\nDecide which tool is needed next to retrieve required definitions, files, or web pages.`
		};
	}

	static createGeneratorPrompt(userGoal: string, denseContext: string): IMicroPrompt {
		return {
			state: 'generator',
			systemPrompt: 'You are OFCode, an expert agentic AI coding assistant. Write complete, working code. NEVER call inline_chat_exit or cancel. Write files using ofcode_writeFile or <ofcode_file path="..."> blocks.',
			userPrompt: `Context:\n${denseContext}\n\nTask: ${userGoal}\nGenerate the complete files and solution now:`
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
