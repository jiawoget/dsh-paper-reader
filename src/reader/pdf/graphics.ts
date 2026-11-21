import { OPS, Util } from 'pdfjs-dist';
import type { PDFOperatorList, PDFPageProxy, StructTreeNode, TextContent, TextItem } from 'pdfjs-dist/types/src/display/api.js';
import { box, type Box, type PageGraphics } from './model.js';

/** Read semantic artwork tags separately so existing text-layer indices and saved anchors stay stable. */
export async function taggedArtwork(page: PDFPageProxy): Promise<TextContent | undefined> {
  const tree = await page.getStructTree();
  if (!tree) return;
  const ids = new Set<string>();
  function visit(node: StructTreeNode, inherited: boolean): void {
    const preserve = node.role !== 'Caption' && (inherited || ['Figure', 'Table', 'Formula'].includes(node.role));
    for (const child of node.children) {
      if ('role' in child) visit(child, preserve);
      else if (preserve && child.type === 'content') ids.add(child.id);
    }
  }
  visit(tree, false);
  if (!ids.size) return;
  const marked = await page.getTextContent({ includeMarkedContent: true });
  const stack: boolean[] = [], items: TextItem[] = [];
  for (const item of marked.items) {
    if ('str' in item) {
      if (stack.at(-1) && item.str.trim()) items.push(item);
    } else if (item.type === 'endMarkedContent') stack.pop();
    else stack.push(ids.has(item.id) || Boolean(stack.at(-1)));
  }
  return { ...marked, items };
}

/** PDF forms and ruled tables often contain ordinary text operators for their lettering. */
export function pageGraphics(list: PDFOperatorList, view: ReturnType<PDFPageProxy['getViewport']>): PageGraphics {
  const forms: Box[] = [], horizontalRules: Box[] = [];
  const stack: number[][] = [];
  let matrix = view.transform;
  function bounds(rect: ArrayLike<number>): Box {
    const r = [Infinity, Infinity, -Infinity, -Infinity];
    Util.axialAlignedBoundingBox(rect, matrix, r);
    return box(r[0], r[1], r[2] - r[0], r[3] - r[1]);
  }
  for (let i = 0; i < list.fnArray.length; i++) {
    const args = list.argsArray[i];
    switch (list.fnArray[i]) {
      case OPS.save:
      case OPS.beginGroup:
        stack.push(matrix);
        break;
      case OPS.transform:
        matrix = Util.transform(matrix, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(matrix);
        if (args[0]) matrix = Util.transform(matrix, args[0]);
        if (args[1]) forms.push(bounds(args[1]));
        break;
      case OPS.restore:
      case OPS.endGroup:
      case OPS.paintFormXObjectEnd:
        matrix = stack.pop() ?? view.transform;
        break;
      case OPS.constructPath:
        if (args[2] && args[0] !== OPS.endPath) {
          const rule = bounds(args[2]);
          if (rule.height < 1.6 && rule.width >= 4) horizontalRules.push(rule);
        }
        break;
    }
  }
  return { forms, horizontalRules };
}
