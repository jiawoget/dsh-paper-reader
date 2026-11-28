import {
  classifyResourceKind, DOC_RESOURCE_KINDS, sanitizeResourceUrl,
  type DocResource, type DocResourceBacklink, type DocResourceKind
} from '../shared/doc-resources.js';
import type { DocumentInfo } from '../shared/types.js';
import { researchIcon, type ResearchIconName } from './research/icons.js';
import { researchText } from './research/labels.js';
import { mkBtn } from './research/paper-intake.js';
import { api, el, message, toast } from './ui.js';

interface DocResourcesPanelOptions {
  docId: string;
  docs?: readonly DocumentInfo[];
  onOpenDoc: (docId: string) => void;
}

const KIND_ICON: Record<DocResourceKind, ResearchIconName> = {
  code: 'code', talk: 'talk', slides: 'slides', dataset: 'dataset', project: 'research', other: 'link'
};
let mountSeq = 0;

function resourceErrorText(error: unknown): string {
  const detail = message(error);
  if (/valid HTTP\(S\) URL/i.test(detail)) return researchText.resourceInvalidUrl();
  if (/Provide a resource URL/i.test(detail)) return researchText.resourceNeedTarget();
  return detail;
}

function externalLink(cls: string, href: string, title: string): HTMLAnchorElement {
  const link = el('a', cls);
  link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = title;
  return link;
}

function isSlideDoc(doc: DocumentInfo): boolean {
  return /\.pptx?$/i.test(doc.title) || Boolean(doc.book?.sections.some(s => s.chapterId === 'slides'));
}

export function mountDocResourcesPanel(container: HTMLElement, opts: DocResourcesPanelOptions): void {
  const token = String(++mountSeq);
  container.dataset.resSeq = token;
  const alive = () => container.isConnected && container.dataset.resSeq === token;

  let docs: readonly DocumentInfo[] = opts.docs ?? [];
  let resources: DocResource[] = [];
  let backlinks: DocResourceBacklink[] = [];
  let mode: 'url' | 'doc' = 'url';
  let kindTouched = false;
  let busy = false;

  const docTitle = (id: string, fallback: string, preferCustom = false): string => {
    const match = docs.find(d => d.id === id);
    if (!match) return fallback;
    if (preferCustom && fallback && fallback !== match.title && fallback !== match.paperTitle) return fallback;
    return match.paperTitle || match.title;
  };

  const section = el('section', 'doc-res');
  section.setAttribute('aria-label', researchText.resourcesHeading());
  const head = el('div', 'doc-res-head'), titleGroup = el('div', 'doc-res-title-group');
  const dot = el('span', 'doc-res-dot'); dot.hidden = true;
  titleGroup.append(el('h3', '', researchText.resourcesHeading()), dot);

  const linkedWrap = el('div', 'doc-res-chips'); linkedWrap.hidden = true;
  const backlinksWrap = el('div', 'doc-res-backlinks'); backlinksWrap.hidden = true;
  const sugWrap = el('div', 'doc-res-suggestions'); sugWrap.hidden = true;

  const form = el('form', 'doc-res-form'); form.hidden = true;
  const modes = el('div', 'doc-res-modes');
  modes.setAttribute('role', 'group'); modes.ariaLabel = researchText.resourceModeGroup();
  const urlIn = el('input', 'doc-res-url');
  urlIn.type = 'text'; urlIn.inputMode = 'url'; urlIn.autocomplete = 'off';
  urlIn.placeholder = 'https://…'; urlIn.ariaLabel = researchText.resourceUrlLabel();
  const docSel = el('select', 'doc-res-doc-sel'); docSel.ariaLabel = researchText.resourceDocLabel();
  const titleIn = el('input', 'doc-res-title-in');
  titleIn.type = 'text'; titleIn.maxLength = 200; titleIn.autocomplete = 'off';
  titleIn.placeholder = researchText.resourceTitleLabel(); titleIn.ariaLabel = researchText.resourceTitleLabel();
  const kindSel = el('select', 'doc-res-kind'); kindSel.ariaLabel = researchText.resourceKindLabel();
  for (const k of DOC_RESOURCE_KINDS) kindSel.append(new Option(researchText.resourceKind(k), k));

  const errEl = el('p', 'doc-res-error'); errEl.setAttribute('role', 'alert'); errEl.hidden = true;
  const submitBtn = el('button', 'btn primary doc-res-submit', researchText.resourceAddSubmit()); submitBtn.type = 'submit';
  const showError = (text: string) => { errEl.textContent = text; errEl.hidden = !text; };

  const syncDocOptions = () => {
    const prev = docSel.value;
    const others = docs.filter(d => d.id !== opts.docId).sort((a, b) => (a.paperTitle || a.title).localeCompare(b.paperTitle || b.title));
    docSel.replaceChildren(new Option(others.length ? researchText.resourceDocPlaceholder() : researchText.resourceNoOtherDocs(), ''));
    for (const d of others) docSel.append(new Option(d.paperTitle || d.title, d.id));
    if (prev && others.some(d => d.id === prev)) docSel.value = prev;
    docSel.disabled = !others.length;
  };

  const syncMode = (next: 'url' | 'doc') => {
    mode = next; kindTouched = false; showError('');
    urlModeBtn.setAttribute('aria-pressed', String(mode === 'url'));
    docModeBtn.setAttribute('aria-pressed', String(mode === 'doc'));
    urlIn.hidden = mode !== 'url'; docSel.hidden = mode !== 'doc';
    if (mode === 'doc') {
      syncDocOptions();
      const chosen = docs.find(d => d.id === docSel.value);
      kindSel.value = chosen && isSlideDoc(chosen) ? 'slides' : 'other';
    } else {
      kindSel.value = urlIn.value.trim() ? classifyResourceKind(urlIn.value.trim(), titleIn.value.trim()) : 'code';
    }
  };

  const closeForm = (restoreFocus = false) => {
    form.hidden = true; showError('');
    urlIn.value = ''; titleIn.value = ''; docSel.value = ''; kindTouched = false;
    addToggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) addToggle.focus({ preventScroll: true });
  };

  const findBtn = mkBtn('btn doc-res-find', researchText.findLinks(), () => {
    findBtn.disabled = true; findBtn.textContent = researchText.findingLinks();
    void api('doc.resources.discover', { docId: opts.docId }).then(res => {
      if (!alive()) return;
      resources = res.resources; backlinks = res.backlinks;
      render(); toast(researchText.resourceFoundToast(res.discovered));
    }, error => { if (alive()) toast(message(error)); }).finally(() => {
      if (alive()) { findBtn.disabled = false; findBtn.textContent = researchText.findLinks(); }
    });
  });
  const addToggle = mkBtn('btn doc-res-add-toggle', researchText.addLink(), () => {
    if (!form.hidden) { closeForm(); return; }
    syncMode('url'); form.hidden = false; addToggle.setAttribute('aria-expanded', 'true');
    urlIn.focus({ preventScroll: true });
  });
  addToggle.setAttribute('aria-expanded', 'false');
  const headActions = el('div', 'doc-res-head-actions'); headActions.append(findBtn, addToggle);
  head.append(titleGroup, headActions);

  const urlModeBtn = mkBtn('doc-res-mode-btn', researchText.resourceUrlMode(), () => { syncMode('url'); urlIn.focus({ preventScroll: true }); });
  const docModeBtn = mkBtn('doc-res-mode-btn', researchText.resourceDocMode(), () => { syncMode('doc'); docSel.focus({ preventScroll: true }); });
  modes.append(urlModeBtn, docModeBtn);
  const row = el('div', 'doc-res-form-row'); row.append(titleIn, kindSel);
  const formActions = el('div', 'doc-res-form-actions');
  formActions.append(submitBtn, mkBtn('btn doc-res-cancel', researchText.resourceCancel(), () => closeForm(true)));
  form.append(modes, urlIn, docSel, row, errEl, formActions);
  section.append(head, linkedWrap, backlinksWrap, sugWrap, form);
  container.replaceChildren(section);

  const render = () => {
    const linked = resources.filter(r => r.status === 'linked');
    const suggested = resources.filter(r => r.status === 'suggested');
    dot.hidden = suggested.length === 0;
    if (suggested.length > 0) {
      dot.textContent = String(suggested.length);
      dot.ariaLabel = dot.title = researchText.resourcePendingBadge(suggested.length);
    }

    linkedWrap.replaceChildren(); linkedWrap.hidden = linked.length === 0;
    for (const item of linked) {
      const chip = el('span', 'doc-res-chip'), iconEl = researchIcon(KIND_ICON[item.kind], 16);
      chip.dataset.kind = item.kind; chip.dataset.resourceId = item.id;
      if (item.targetDocId) {
        const targetId = item.targetDocId, label = docTitle(targetId, item.title, true);
        chip.dataset.targetDocId = targetId;
        const openBtn = mkBtn('doc-res-chip-main', '', () => opts.onOpenDoc(targetId));
        openBtn.title = label; openBtn.append(iconEl, el('span', 'doc-res-chip-title', label));
        chip.append(openBtn);
      } else {
        const href = item.url ? sanitizeResourceUrl(item.url) : null;
        if (!href) continue;
        const link = externalLink('doc-res-chip-main', href, item.title);
        link.append(iconEl, el('span', 'doc-res-chip-title', item.title));
        chip.append(link);
      }
      const delBtn = mkBtn('doc-res-chip-del', '×', () => {
        delBtn.disabled = true;
        void api('doc.resources.remove', { id: item.id }).then(() => {
          if (!alive()) return;
          resources = resources.filter(r => r.id !== item.id); render();
        }, error => { if (alive()) { delBtn.disabled = false; toast(message(error)); } });
      });
      delBtn.ariaLabel = delBtn.title = researchText.resourceRemove();
      chip.append(delBtn); linkedWrap.append(chip);
    }

    backlinksWrap.replaceChildren(); backlinksWrap.hidden = backlinks.length === 0;
    if (backlinks.length > 0) {
      const list = el('div', 'doc-res-backlinks-list');
      for (const bl of backlinks) {
        const parentTitle = docTitle(bl.sourceDocId, bl.title);
        const btn = mkBtn('doc-res-backlink-chip', '', () => opts.onOpenDoc(bl.sourceDocId));
        btn.dataset.sourceDocId = bl.sourceDocId; btn.title = parentTitle;
        btn.append(el('span', '', `← ${parentTitle}`)); list.append(btn);
      }
      backlinksWrap.append(el('span', 'doc-res-subhead', researchText.resourceLinkedFrom()), list);
    }

    sugWrap.replaceChildren(); sugWrap.hidden = suggested.length === 0;
    if (suggested.length > 0) {
      sugWrap.append(el('span', 'doc-res-subhead', researchText.resourceSuggested()));
      for (const item of suggested) {
        const rowEl = el('div', 'doc-res-sug-row'), info = el('div', 'doc-res-sug-info');
        rowEl.dataset.resourceId = item.id; info.append(researchIcon(KIND_ICON[item.kind], 16));
        const href = item.url ? sanitizeResourceUrl(item.url) : null;
        if (href) { const link = externalLink('doc-res-sug-link', href, href); link.textContent = item.title; info.append(link); }
        else info.append(el('span', 'doc-res-sug-link', item.title));
        const update = (status: 'linked' | 'dismissed') => {
          acceptBtn.disabled = dismissBtn.disabled = true;
          void api('doc.resources.update', { id: item.id, status }).then(({ resource }) => {
            if (!alive()) return;
            resources = status === 'dismissed' ? resources.filter(r => r.id !== item.id) : resources.map(r => r.id === item.id ? resource : r);
            render();
          }, error => { if (alive()) { acceptBtn.disabled = dismissBtn.disabled = false; toast(message(error)); } });
        };
        const acceptBtn = mkBtn('btn doc-res-accept', researchText.resourceAccept(), () => update('linked'));
        const dismissBtn = mkBtn('btn doc-res-dismiss', researchText.resourceDismiss(), () => update('dismissed'));
        const actions = el('div', 'doc-res-sug-actions'); actions.append(acceptBtn, dismissBtn);
        rowEl.append(info, actions); sugWrap.append(rowEl);
      }
    }
  };

  kindSel.addEventListener('change', () => { kindTouched = true; });
  urlIn.addEventListener('input', () => {
    if (!kindTouched && urlIn.value.trim()) kindSel.value = classifyResourceKind(urlIn.value.trim(), titleIn.value.trim());
  });
  docSel.addEventListener('change', () => {
    if (kindTouched) return;
    const chosen = docs.find(d => d.id === docSel.value);
    if (chosen) kindSel.value = isSlideDoc(chosen) ? 'slides' : 'other';
  });
  form.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); closeForm(true); } });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (busy) return;
    showError('');
    const kind = kindSel.value as DocResourceKind, title = titleIn.value.trim() || undefined;
    const rawUrl = urlIn.value.trim(), targetDocId = docSel.value;
    if ((mode === 'url' && !rawUrl) || (mode === 'doc' && !targetDocId)) { showError(researchText.resourceNeedTarget()); return; }
    const payload = mode === 'url'
      ? { docId: opts.docId, url: rawUrl, kind, ...(title ? { title } : {}) }
      : { docId: opts.docId, targetDocId, kind, ...(title ? { title } : {}) };
    busy = true; submitBtn.disabled = true;
    try {
      const { resource } = await api('doc.resources.add', payload);
      if (!alive()) return;
      resources = [resource, ...resources.filter(r => r.id !== resource.id)];
      closeForm(true); render();
    } catch (error) { if (alive()) showError(resourceErrorText(error)); }
    finally { if (alive()) { busy = false; submitBtn.disabled = false; } }
  });

  syncMode('url');
  const docsPromise = opts.docs ? Promise.resolve(opts.docs) : api('library.list', {}).then(r => r.docs).catch(() => [] as DocumentInfo[]);
  void Promise.all([api('doc.resources.list', { docId: opts.docId }), docsPromise]).then(([listRes, loadedDocs]) => {
    if (!alive()) return;
    docs = loadedDocs; resources = listRes.resources; backlinks = listRes.backlinks;
    syncDocOptions(); render();
  }).catch(() => undefined);
}
