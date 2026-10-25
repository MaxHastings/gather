export type TextPart = { type: string; value: string };
export function inlineText(source: string): TextPart[];
export function messageText(source: string): TextPart[];
