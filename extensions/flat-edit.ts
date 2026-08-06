/**
 * flat-edit: replaces pi's built-in `edit` tool (nested `edits[]` array schema)
 * with a flat-string schema variant.
 *
 * Why: DeepSeek V4 Pro (cheaper) via NanoGPT deterministically fails to emit
 * nested-array tool schemas — NanoGPT's DSML translation chokes and returns
 * `malformed_tool_call` (experiments/results/FINDINGS.md). Flat string
 * parameters round-trip 100%.
 *
 * Load with `-e extensions/flat-edit.ts`. If a `--tools` allowlist is supplied,
 * it must include `edit` or pi will suppress this override along with the built-in.
 */
import { Type, type Static } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const EditParams = Type.Object({
	path: Type.String({ description: "Path to the file to edit" }),
	oldText: Type.String({ description: "Exact existing text to replace (must be unique in the file)" }),
	newText: Type.String({ description: "Replacement text" }),
});

function normalizeWithRawBoundaries(raw: string): { text: string; rawBoundaries: number[] } {
	let text = "";
	const rawBoundaries = [0];
	for (let i = 0; i < raw.length; ) {
		if (raw[i] === "\r") {
			i += raw[i + 1] === "\n" ? 2 : 1;
			text += "\n";
		} else {
			text += raw[i];
			i += 1;
		}
		rawBoundaries.push(i);
	}
	return { text, rawBoundaries };
}

type LineEnding = "\n" | "\r\n" | "\r";

function firstLineEnding(text: string, start = 0, end = text.length): LineEnding | undefined {
	for (let i = start; i < end; i += 1) {
		if (text[i] === "\n") return "\n";
		if (text[i] === "\r") return text[i + 1] === "\n" ? "\r\n" : "\r";
	}
}

function lastLineEndingBefore(text: string, end: number): LineEnding | undefined {
	let last: LineEnding | undefined;
	for (let i = 0; i < end; i += 1) {
		if (text[i] === "\n") last = "\n";
		else if (text[i] === "\r") {
			last = text[i + 1] === "\n" ? "\r\n" : "\r";
			if (last === "\r\n") i += 1;
		}
	}
	return last;
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// Narrow structural type for the one pi extension API this file calls. Deliberately not importing
// pi's SDK (CLAUDE.md: "Never import from pi's SDK") — this keeps typecheck decoupled from pi's
// frequently-reshuffled package.
interface ExtensionAPI {
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		executionMode?: "sequential" | "parallel";
		parameters: typeof EditParams;
		execute: (
			toolCallId: string,
			params: Static<typeof EditParams>,
			signal: AbortSignal,
			onUpdate: (update: unknown) => void,
			ctx: unknown,
		) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
	}): void;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "edit",
		label: "Edit (flat)",
		description:
			"Edit a single file using exact text replacement. oldText must match exactly one region of the file; it is replaced with newText. Include enough surrounding context in oldText to make the match unique.",
		executionMode: "sequential",
		parameters: EditParams,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const file = path.resolve(params.path);
			if (!fs.existsSync(file)) throw new Error(`File not found: ${params.path}`);
			const rawText = fs.readFileSync(file, "utf8");
			const bom = rawText.startsWith("\uFEFF") ? "\uFEFF" : "";
			const text = bom ? rawText.slice(1) : rawText;
			const normalized = normalizeWithRawBoundaries(text);
			const rawBoundarySet = new Set(normalized.rawBoundaries);

			let first = -1;
			let end = -1;
			if (params.oldText.length > 0) {
				for (let searchFrom = 0; ; ) {
					const found = text.indexOf(params.oldText, searchFrom);
					if (found === -1) break;
					const foundEnd = found + params.oldText.length;
					if (rawBoundarySet.has(found) && rawBoundarySet.has(foundEnd)) {
						if (first !== -1)
							throw new Error(`oldText matches more than once in ${params.path}; add surrounding context to make it unique`);
						first = found;
						end = foundEnd;
					}
					searchFrom = found + 1;
				}
			}
			if (first === -1) {
				const oldText = normalizeLineEndings(params.oldText);
				const normalizedFirst = normalized.text.indexOf(oldText);
				if (normalizedFirst === -1) throw new Error(`oldText not found in ${params.path}`);
				if (normalized.text.indexOf(oldText, normalizedFirst + 1) !== -1)
					throw new Error(`oldText matches more than once in ${params.path}; add surrounding context to make it unique`);
				first = normalized.rawBoundaries[normalizedFirst];
				end = normalized.rawBoundaries[normalizedFirst + oldText.length];
			}

			const lineEnding =
				firstLineEnding(text, first, end) ?? firstLineEnding(text, end) ?? lastLineEndingBefore(text, first) ?? "\n";
			const newText = normalizeLineEndings(params.newText).replace(/\n/g, lineEnding);
			fs.writeFileSync(file, bom + text.slice(0, first) + newText + text.slice(end));
			return {
				content: [{ type: "text", text: `Edited ${params.path}` }],
				details: {},
			};
		},
	});
}
