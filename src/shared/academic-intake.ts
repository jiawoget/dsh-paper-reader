import { extractArxivId } from './citation-export.js';

export type AcademicTarget =
  | { kind: 'arxiv'; id: string; versionedId: string; absUrl: string; pdfUrl: string }
  | { kind: 'doi'; doi: string; url: string }
  | { kind: 'url'; url: string };

const ARXIV_URL_RE = /^\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?)(?:\.pdf)?\/?$/i;
const DOI_RE = /^10\.\d{4,9}\/[^\s<>"]+$/i;
const arxiv = (id: string, versionedId: string): AcademicTarget =>
  ({ kind: 'arxiv', id, versionedId, absUrl: 'https://arxiv.org/abs/' + versionedId, pdfUrl: 'https://arxiv.org/pdf/' + versionedId + '.pdf' });

function doiTarget(raw: string): AcademicTarget | null {
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}
  const doi = decoded.replace(/[.,;]+$/, '').trim();
  return DOI_RE.test(doi) && !/\\/.test(decoded) && !/(?:^|\/)\.\.(?:\/|$)/.test(decoded) ? { kind: 'doi', doi, url: 'https://doi.org/' + encodeURI(doi) } : null;
}

export function parseAcademicInput(raw: unknown): AcademicTarget | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 8192 || /[\u0000-\u001f\u007f]/.test(text)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme && !['http', 'https', 'arxiv', 'doi'].includes(scheme)) return null;
  const ver = (s: string) => /(v\d+)\/?$/i.exec(s)?.[1]?.toLowerCase() ?? '';
  if (scheme === 'http' || scheme === 'https') {
    const url = URL.parse(text);
    if (!url || url.username || url.password) return null;
    if (/(?:^|\.)arxiv\.org$/i.test(url.hostname)) {
      const m = ARXIV_URL_RE.exec(url.pathname);
      return m ? arxiv(extractArxivId(url.href) ?? m[1].toLowerCase().replace(/v\d+$/, ''), m[1].toLowerCase()) : { kind: 'url', url: url.href };
    }
    if (/^(?:dx\.)?doi\.org$/i.test(url.hostname)) {
      const id = extractArxivId(url.href);
      return id ? arxiv(id, id + ver(url.pathname)) : doiTarget(url.pathname.slice(1).replace(/\/+$/, ''));
    }
    return { kind: 'url', url: url.href };
  }
  const id = extractArxivId(text);
  return id ? arxiv(id, id + ver(text)) : doiTarget(text.replace(/^doi:\s*/i, '').trim());
}
