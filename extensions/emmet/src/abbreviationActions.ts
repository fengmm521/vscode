/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { expand } from '@emmetio/expand-abbreviation';
import { Node, HtmlNode, Rule } from 'EmmetNode';
import { getNode, getInnerRange, getMappingForIncludedLanguages, parseDocument, validate } from './util';
import { getExpandOptions, extractAbbreviation, isStyleSheet, isAbbreviationValid, getEmmetMode } from 'vscode-emmet-helper';

interface ExpandAbbreviationInput {
	syntax: string;
	abbreviation: string;
	rangeToReplace: vscode.Range;
	textToWrap?: string;
}

export function wrapWithAbbreviation(args) {
	const syntax = getSyntaxFromArgs(args);
	if (!syntax || !validate()) {
		return;
	}

	const editor = vscode.window.activeTextEditor;
	const abbreviationPromise = (args && args['abbreviation']) ? Promise.resolve(args['abbreviation']) : vscode.window.showInputBox({ prompt: 'Enter Abbreviation' });

	return abbreviationPromise.then(abbreviation => {
		if (!abbreviation || !abbreviation.trim() || !isAbbreviationValid(syntax, abbreviation)) { return; }

		let expandAbbrList: ExpandAbbreviationInput[] = [];

		editor.selections.forEach(selection => {
			let rangeToReplace: vscode.Range = selection.isReversed ? new vscode.Range(selection.active, selection.anchor) : selection;
			if (rangeToReplace.isEmpty) {
				rangeToReplace = new vscode.Range(rangeToReplace.start.line, 0, rangeToReplace.start.line, editor.document.lineAt(rangeToReplace.start.line).text.length);
			}

			const firstLineOfSelection = editor.document.lineAt(rangeToReplace.start).text.substr(rangeToReplace.start.character);
			const matches = firstLineOfSelection.match(/^(\s*)/);
			const preceedingWhiteSpace = matches ? matches[1].length : 0;

			rangeToReplace = new vscode.Range(rangeToReplace.start.line, rangeToReplace.start.character + preceedingWhiteSpace, rangeToReplace.end.line, rangeToReplace.end.character);
			expandAbbrList.push({ syntax, abbreviation, rangeToReplace, textToWrap: '\n\t\$TM_SELECTED_TEXT\n' });
		});

		return expandAbbreviationInRange(editor, expandAbbrList, true);
	});
}

export function expandAbbreviation(args) {
	const syntax = getSyntaxFromArgs(args);
	if (!syntax || !validate()) {
		return;
	}

	const editor = vscode.window.activeTextEditor;

	let rootNode = parseDocument(editor.document);
	if (!rootNode) {
		return;
	}

	let abbreviationList: ExpandAbbreviationInput[] = [];
	let firstAbbreviation: string;
	let allAbbreviationsSame: boolean = true;

	let getAbbreviation = (document: vscode.TextDocument, selection: vscode.Selection, position: vscode.Position, isHtml: boolean): [vscode.Range, string] => {
		let rangeToReplace: vscode.Range = selection;
		let abbreviation = document.getText(rangeToReplace);
		if (!rangeToReplace.isEmpty) {
			return [rangeToReplace, abbreviation];
		}

		// Expand cases like <div to <div></div> explicitly
		// else we will end up with <<div></div>
		if (isHtml) {
			const currentLine = editor.document.lineAt(position.line).text;
			const textTillPosition = currentLine.substr(0, position.character);
			let matches = textTillPosition.match(/<(\w+)$/);
			if (matches) {
				abbreviation = matches[1];
				rangeToReplace = new vscode.Range(position.translate(0, -(abbreviation.length + 1)), position);
				return [rangeToReplace, abbreviation];
			}
		}
		return extractAbbreviation(editor.document, position);
	};

	editor.selections.forEach(selection => {
		let position = selection.isReversed ? selection.anchor : selection.active;
		let [rangeToReplace, abbreviation] = getAbbreviation(editor.document, selection, position, syntax === 'html');
		if (!isAbbreviationValid(syntax, abbreviation)) {
			vscode.window.showErrorMessage('Emmet: Invalid abbreviation');
			return;
		}

		let currentNode = getNode(rootNode, position);
		if (!isValidLocationForEmmetAbbreviation(currentNode, syntax, position)) {
			return;
		}

		if (!firstAbbreviation) {
			firstAbbreviation = abbreviation;
		} else if (allAbbreviationsSame && firstAbbreviation !== abbreviation) {
			allAbbreviationsSame = false;
		}

		abbreviationList.push({ syntax, abbreviation, rangeToReplace });
	});

	return expandAbbreviationInRange(editor, abbreviationList, allAbbreviationsSame);
}


/**
 * Checks if given position is a valid location to expand emmet abbreviation.
 * Works only on html and css/less/scss syntax
 * @param currentNode parsed node at given position
 * @param syntax syntax of the abbreviation
 * @param position position to validate
 */
export function isValidLocationForEmmetAbbreviation(currentNode: Node, syntax: string, position: vscode.Position): boolean {
	if (!currentNode) {
		return !isStyleSheet(syntax);
	}

	if (isStyleSheet(syntax)) {
		if (currentNode.type !== 'rule') {
			return true;
		}
		const currentCssNode = <Rule>currentNode;

		// Workaround for https://github.com/Microsoft/vscode/30188
		if (currentCssNode.parent
			&& currentCssNode.parent.type === 'rule'
			&& currentCssNode.selectorToken
			&& currentCssNode.selectorToken.start.line !== currentCssNode.selectorToken.end.line) {
			return true;
		}

		// Position is valid if it occurs after the `{` that marks beginning of rule contents
		return currentCssNode.selectorToken && position.isAfter(currentCssNode.selectorToken.end);
	}

	const currentHtmlNode = <HtmlNode>currentNode;
	if (currentHtmlNode.close) {
		return getInnerRange(currentHtmlNode).contains(position);
	}

	return false;
}

/**
 * Expands abbreviations as detailed in expandAbbrList in the editor
 * @param editor
 * @param expandAbbrList
 * @param insertSameSnippet
 */
function expandAbbreviationInRange(editor: vscode.TextEditor, expandAbbrList: ExpandAbbreviationInput[], insertSameSnippet: boolean): Thenable<boolean> {
	if (!expandAbbrList || expandAbbrList.length === 0) {
		return;
	}

	// Snippet to replace at multiple cursors are not the same
	// `editor.insertSnippet` will have to be called for each instance separately
	// We will not be able to maintain multiple cursors after snippet insertion
	let insertPromises = [];
	if (!insertSameSnippet) {
		expandAbbrList.forEach((expandAbbrInput: ExpandAbbreviationInput) => {
			let expandedText = expandAbbr(expandAbbrInput);
			if (expandedText) {
				insertPromises.push(editor.insertSnippet(new vscode.SnippetString(expandedText), expandAbbrInput.rangeToReplace));
			}
		});
		return Promise.all(insertPromises).then(() => Promise.resolve(true));
	}

	// Snippet to replace at all cursors are the same
	// We can pass all ranges to `editor.insertSnippet` in a single call so that
	// all cursors are maintained after snippet insertion
	const anyExpandAbbrInput = expandAbbrList[0];
	let expandedText = expandAbbr(anyExpandAbbrInput);
	let allRanges = expandAbbrList.map(value => {
		return new vscode.Range(value.rangeToReplace.start.line, value.rangeToReplace.start.character, value.rangeToReplace.end.line, value.rangeToReplace.end.character);
	});
	if (expandedText) {
		return editor.insertSnippet(new vscode.SnippetString(expandedText), allRanges);
	}
}

/**
 * Expands abbreviation as detailed in given input.
 */
function expandAbbr(input: ExpandAbbreviationInput): string {
	const emmetConfig = vscode.workspace.getConfiguration('emmet');
	const expandOptions = getExpandOptions(emmetConfig['syntaxProfiles'], emmetConfig['variables'], input.syntax, input.textToWrap);

	// Below fixes https://github.com/Microsoft/vscode/issues/29898
	// With this, Emmet formats inline elements as block elements
	// ensuring the wrapped multi line text does not get merged to a single line
	if (input.textToWrap && !input.rangeToReplace.isSingleLine) {
		expandOptions.profile['inlineBreak'] = 1;
	}

	try {
		// Expand the abbreviation
		let expandedText = expand(input.abbreviation, expandOptions);

		// If the expanded text is single line then we dont need the \t we added to $TM_SELECTED_TEXT earlier
		if (input.textToWrap && expandedText.indexOf('\n') === -1) {
			expandedText = expandedText.replace(/\s*\$TM_SELECTED_TEXT\s*/, '\$TM_SELECTED_TEXT');
		}
		return expandedText;

	} catch (e) {
		vscode.window.showErrorMessage('Failed to expand abbreviation');
	}


}

function getSyntaxFromArgs(args: any): string {
	let editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showInformationMessage('No editor is active.');
		return;
	}

	const mappedModes = getMappingForIncludedLanguages();
	let language: string = (!args || typeof args !== 'object' || !args['language']) ? editor.document.languageId : args['language'];
	let parentMode: string = (args && typeof args === 'object') ? args['parentMode'] : undefined;
	let excludedLanguages = vscode.workspace.getConfiguration('emmet')['exlcudeLanguages'] ? vscode.workspace.getConfiguration('emmet')['exlcudeLanguages'] : [];
	let syntax = getEmmetMode((mappedModes[language] ? mappedModes[language] : language), excludedLanguages);
	if (syntax) {
		return syntax;
	}

	return getEmmetMode((mappedModes[parentMode] ? mappedModes[parentMode] : parentMode), excludedLanguages);
}