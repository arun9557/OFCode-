/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

/**
 * Kiro.dev-Inspired "Cosmic Obsidian & Electric Violet" Theme Contribution.
 *
 * On first launch (tracked via storage key), this contribution automatically
 * applies a curated dark-violet color palette to the workbench via
 * `workbench.colorCustomizations`. It does NOT overwrite user-set values on
 * subsequent launches.
 */
export class OFCodeKiroThemeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chat.ofcodeKiroThemeContribution';

	private static readonly STORAGE_KEY = 'ofcode.kiroTheme.applied';

	/**
	 * The full Kiro-style "Cosmic Obsidian & Electric Violet" palette.
	 */
	private static readonly KIRO_PALETTE: Record<string, string> = {
		// Editor core
		'editor.background': '#0B0914',
		'editor.foreground': '#E2D9F3',

		// Sidebar
		'sideBar.background': '#110D1D',
		'sideBar.border': '#261E3F',
		'sideBar.foreground': '#C4B5D8',

		// Activity Bar
		'activityBar.background': '#090710',
		'activityBar.foreground': '#A855F7',
		'activityBar.inactiveForeground': '#6D5B8A',
		'activityBarBadge.background': '#8B5CF6',
		'activityBarBadge.foreground': '#FFFFFF',

		// Panel (terminal, output, etc.)
		'panel.background': '#0E0B18',
		'panel.border': '#261E3F',

		// Title Bar
		'titleBar.activeBackground': '#090710',
		'titleBar.activeForeground': '#E9D5FF',
		'titleBar.inactiveBackground': '#07050E',
		'titleBar.inactiveForeground': '#8B7AAA',

		// Status Bar
		'statusBar.background': '#130E24',
		'statusBar.foreground': '#C084FC',
		'statusBar.border': '#2E234E',
		'statusBar.debuggingBackground': '#7C3AED',
		'statusBar.noFolderBackground': '#0E0B18',

		// Buttons
		'button.background': '#7C3AED',
		'button.hoverBackground': '#9333EA',
		'button.foreground': '#FFFFFF',

		// Focus & Links
		'focusBorder': '#8B5CF6',
		'textLink.foreground': '#A855F7',
		'textLink.activeForeground': '#C084FC',

		// Chat panel
		'chat.requestBackground': '#171226',
		'chat.slashCommandBackground': '#2E1065',
		'chat.slashCommandForeground': '#D8B4FE',

		// Input
		'input.background': '#130E24',
		'input.border': '#2E234E',
		'input.foreground': '#E9D5FF',
		'input.placeholderForeground': '#6D5B8A',

		// List / Tree
		'list.activeSelectionBackground': '#2E1065',
		'list.activeSelectionForeground': '#E9D5FF',
		'list.hoverBackground': '#1A1330',
		'list.inactiveSelectionBackground': '#1A1330',

		// Tabs
		'tab.activeBackground': '#130E24',
		'tab.activeForeground': '#E9D5FF',
		'tab.inactiveBackground': '#0B0914',
		'tab.inactiveForeground': '#6D5B8A',
		'tab.border': '#261E3F',

		// Scrollbar
		'scrollbarSlider.background': '#2E1065AA',
		'scrollbarSlider.hoverBackground': '#7C3AEDAA',
		'scrollbarSlider.activeBackground': '#9333EACC',

		// Editor widgets
		'editorWidget.background': '#110D1D',
		'editorWidget.border': '#2E234E',

		// Peek view
		'peekView.border': '#8B5CF6',
		'peekViewTitle.background': '#130E24',

		// Badge
		'badge.background': '#7C3AED',
		'badge.foreground': '#FFFFFF',

		// Notifications
		'notificationCenter.border': '#261E3F',
		'notifications.background': '#110D1D',
		'notifications.border': '#2E234E',
	};

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._applyThemeIfFirstLaunch();
	}

	private _applyThemeIfFirstLaunch(): void {
		const alreadyApplied = this._storageService.getBoolean(
			OFCodeKiroThemeContribution.STORAGE_KEY,
			StorageScope.PROFILE,
			false
		);

		if (alreadyApplied) {
			return;
		}

		// Get existing color customizations (if any), and merge — never clobber
		const existing = this._configurationService.getValue<Record<string, string>>('workbench.colorCustomizations') ?? {};
		const merged: Record<string, string> = { ...OFCodeKiroThemeContribution.KIRO_PALETTE };

		// Preserve any user overrides
		for (const [key, value] of Object.entries(existing)) {
			if (value) {
				merged[key] = value;
			}
		}

		this._configurationService.updateValue('workbench.colorCustomizations', merged);
		this._storageService.store(
			OFCodeKiroThemeContribution.STORAGE_KEY,
			true,
			StorageScope.PROFILE,
			StorageTarget.USER
		);
	}
}
