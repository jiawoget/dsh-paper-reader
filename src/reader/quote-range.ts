/** Prefer the selected occurrence, even when the same term appears twice in a paragraph. */
export function textRange(node: Node | null | undefined, quote: string, offset?: number): Range | null {
  if (!(node instanceof Text) || !quote) return null;
  const at = offset !== undefined && Number.isSafeInteger(offset) && offset >= 0 && node.data.startsWith(quote, offset)
    ? offset : node.data.indexOf(quote);
  if (at < 0) return null;
  const range = node.ownerDocument.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + quote.length);
  return range;
}

export function clipToText(range: Range, node: Node | null): Range | undefined {
  if (!(node instanceof Text) || !range.intersectsNode(node)) return;
  const start = range.startContainer === node ? range.startOffset : 0;
  const end = range.endContainer === node ? range.endOffset : node.length;
  if (end <= start) return;
  const clipped = node.ownerDocument.createRange();
  clipped.setStart(node, start);
  clipped.setEnd(node, end);
  return clipped;
}
