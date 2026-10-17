/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export class MarkdownConverter {
	/**
	 * Converts sanitized HTML elements into clean Markdown format.
	 */
	static htmlToMarkdown(html: string): string {
		let md = html;

		// Headings
		md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
		md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
		md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
		md = md.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n');

		// Code blocks & inline code
		md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
		md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

		// Lists
		md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
		md = md.replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n');

		// Paragraphs and breaks
		md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');
		md = md.replace(/<br\s*\/?>/gi, '\n');

		// Links - keep anchor text and URL
		md = md.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

		// Strip remaining HTML tags
		md = md.replace(/<[^>]+>/g, '');

		// Unescape common HTML entities
		md = md.replace(/&amp;/g, '&');
		md = md.replace(/&lt;/g, '<');
		md = md.replace(/&gt;/g, '>');
		md = md.replace(/&quot;/g, '"');
		md = md.replace(/&#39;/g, "'");
		md = md.replace(/&nbsp;/g, ' ');

		// Clean up excessive blank lines
		md = md.replace(/\n{3,}/g, '\n\n');

		return md.trim();
	}
}
