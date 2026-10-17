/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { ILanguageModelToolsService } from '../languageModelToolsService.js';
import { HighRagTool, HighRagToolData } from './highRagTool.js';
import { ChromeExtractTool, ChromeExtractToolData } from './chromeExtractTool.js';
import { GitHubExploreTool, GitHubExploreToolData } from './githubExploreTool.js';

export class OfflineAgentToolsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chat.offlineAgentTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		// 1. High-RAG Tool (AST + Local Embeddings + Call Graph)
		const highRagTool = this._register(instantiationService.createInstance(HighRagTool));
		this._register(toolsService.registerTool(HighRagToolData, highRagTool));
		this._register(toolsService.readToolSet.addTool(HighRagToolData));

		// 2. Chrome & Web Extractor (Stripped HTML -> Clean Markdown)
		const chromeExtractTool = this._register(instantiationService.createInstance(ChromeExtractTool));
		this._register(toolsService.registerTool(ChromeExtractToolData, chromeExtractTool));
		this._register(toolsService.vscodeToolSet.addTool(ChromeExtractToolData));

		// 3. GitHub Deep Explorer (Repo Trees, Files & Issues)
		const githubExploreTool = this._register(instantiationService.createInstance(GitHubExploreTool));
		this._register(toolsService.registerTool(GitHubExploreToolData, githubExploreTool));
		this._register(toolsService.readToolSet.addTool(GitHubExploreToolData));
	}
}
