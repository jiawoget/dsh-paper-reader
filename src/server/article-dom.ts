import type { DefaultTreeAdapterTypes as Dom } from 'parse5';
import type { ArticleTree } from '../shared/web-article.js';

export const htmlTree: ArticleTree<Dom.Node> = {
  tag: node => node.nodeName,
  attr: (node, key) => 'attrs' in node ? node.attrs.find(attribute => attribute.name === key)?.value ?? null : null,
  children: node => 'childNodes' in node ? node.childNodes : [],
  text: node => 'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(child => htmlTree.text(child)).join('') : ''
};
