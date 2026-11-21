import { maxPreviousMaterials } from '../shared/types.js';
import { boundedResponseText } from './provider-http.js';
import { isObject, ServiceError, stringValue, type Input } from './service-types.js';

const prefix = 'data:image/png;base64,';
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const pngEnd = Buffer.from('0000000049454e44ae426082', 'hex');
const maxEdge = 1600;

export interface RegionImage { url: string; bytes: Buffer }
interface PreviousMaterial { label: string; text: string; image?: RegionImage; readerNotes?: string[] }
export class UnsupportedImageInput extends Error {}

export async function readRegionImage(value: unknown, attachments?: Input): Promise<RegionImage> {
  const invalid = () => new ServiceError(400, 'The selected area must be a valid PNG image. Select the area again.');
  const tooLarge = () => new ServiceError(413, 'The screenshot is too large. Select a smaller area.');
  if (typeof value !== 'string' || !value.startsWith(prefix)) throw invalid();
  if (value.length > 2 * 1024 * 1024) throw tooLarge();
  const encoded = value.slice(prefix.length);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 45 || bytes.toString('base64') !== encoded || !bytes.subarray(0, 8).equals(pngSignature) ||
    bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' || !bytes.subarray(-12).equals(pngEnd)) throw invalid();
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height) throw invalid();
  if (Math.max(width, height) > maxEdge) throw tooLarge();
  // Use the host's decoder when mounted. Loading a second libvips version first can break DSH attachments on Windows.
  if (typeof attachments?.validateImage === 'function') {
    try { await attachments.validateImage({ data: bytes, mediaType: 'image/png' }); }
    catch (error) {
      const code = isObject(error) ? error.code : undefined;
      if (code === 'IMAGE_TOO_LARGE' || code === 'IMAGE_TOO_MANY_PIXELS' || code === 'IMAGE_DIMENSION_TOO_LARGE') throw tooLarge();
      if (code === 'INVALID_IMAGE' || code === 'IMAGE_TYPE_MISMATCH' || code === 'UNSUPPORTED_IMAGE_TYPE') throw invalid();
      throw new ServiceError(503, 'DSH could not validate the screenshot. Check the reader installation.');
    }
  } else {
    const { default: sharp } = await import('sharp').catch(() => {
      throw new ServiceError(503, 'The reader could not load its screenshot decoder. Check the reader installation.');
    });
    try {
      // A signature/metadata check alone accepts truncated or unreadable pixels.
      await sharp(bytes, { limitInputPixels: maxEdge * maxEdge, failOn: 'warning' }).raw().toBuffer();
    } catch { throw invalid(); }
  }
  return { url: value, bytes };
}

export function readReaderNotes(value: unknown): string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new ServiceError(400, 'The saved notes must be a list of text entries.');
  if (value.length) return value.map(note => stringValue(note, 'saved note', 100_000, true, true));
}

export async function readPreviousMaterial(value: unknown, currentImage: RegionImage | undefined, attachments?: Input): Promise<PreviousMaterial[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ServiceError(400, 'The earlier selections must be an array.');
  if (value.length > maxPreviousMaterials) throw new ServiceError(413, 'A question can include up to ' + (maxPreviousMaterials + 1) + ' selections.');
  let totalImageLength = currentImage?.url.length ?? 0, totalTextLength = 0;
  const material: PreviousMaterial[] = [];
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.text !== 'string') throw new ServiceError(400, 'An earlier selection must include a label and its selected text.');
    const label = stringValue(entry.label, 'earlier selection label', 512, true);
    const text = stringValue(entry.text, 'earlier selected text', 100_000, entry.image === undefined);
    totalTextLength += entry.text.length;
    if (totalTextLength > 120_000) throw new ServiceError(413, 'The earlier selections contain too much text. Choose shorter passages.');
    totalImageLength += typeof entry.image === 'string' ? entry.image.length : 0;
    if (totalImageLength > 4 * 1024 * 1024) throw new ServiceError(413, 'The selected screenshots are too large together. Choose smaller areas.');
    const image = entry.image === undefined ? undefined : await readRegionImage(entry.image, attachments);
    material.push({ label, text, image, readerNotes: readReaderNotes(entry.readerNotes) });
  }
  return material;
}

export function imageInputRejected(error: unknown): boolean {
  const code = isObject(error) && typeof error.code === 'string' ? error.code.toLowerCase() : '';
  if (['unsupported_image_input', 'image_input_unsupported', 'image_input_not_supported', 'model_does_not_support_images'].includes(code)) return true;
  const message = typeof error === 'string' ? error : isObject(error) && typeof error.message === 'string' ? error.message : '';
  // A format, encoding, size or URL error says nothing about model modalities.
  if (/\b(format|encoding|base64|size|dimensions?|resolution|mime|scheme|larger|smaller|pixels?|output)\b/i.test(message) ||
    /格式|尺寸|解码|下载|文本输出/u.test(message)) return false;
  return /(?:does not|doesn't|cannot|can't) (?:accept|support) (?:images?\b|image_url\b|vision\b)/i.test(message) ||
    /(?:model|endpoint) (?:cannot|can't) (?:process|handle) (?:images|image inputs?)[.!]?$/i.test(message) ||
    /(?:images?|image_url|vision|multimodal)(?: inputs?| content| messages?)? (?:is |are )?(?:unsupported|not (?:supported|allowed|accepted)|only supported by)/i.test(message) ||
    /(?:model|endpoint) is text[- ]only|\btext[- ]only (?:model|endpoint)\b/i.test(message) ||
    /(?:model|endpoint) (?:only (?:accepts|supports)|(?:accepts|supports) only) (?:plain )?text\b/i.test(message) ||
    /(?:unknown|unexpected) variant [`'"]image_url[`'"],? expected [`'"]text[`'"]/i.test(message) ||
    /unsupported content type:\s*[`'"]?image_url\b/i.test(message) ||
    /messages\[\d+\]\.content[`'"]?\s*:\s*(?:expected|must be) (?:a )?string\b/i.test(message) ||
    /no endpoints? (?:found )?(?:that )?support(?:s|ing)? image input|image input requires (?:a vision model|the durable attachment service)/i.test(message) ||
    /(?:模型不支持(?:图像|图片|视觉)(?:输入)?|模型仅支持文本输入|纯文本模型)/u.test(message);
}

export function checkRegionAnswer(text: string, images: readonly RegionImage[]): string {
  // A misconfigured endpoint may echo its input into an answer destined for the notebook.
  if (/data:image\/[\w.+-]+;base64,[a-z0-9+/]{24}/i.test(text) || images.some(image => text.includes(image.url.slice(prefix.length)))) {
    throw new ServiceError(502, 'The model returned image data in its answer. Retry the question or check the model settings.');
  }
  return text;
}

export async function responseRejectsImage(response: Response): Promise<boolean> {
  if (![400, 404, 415, 422].includes(response.status)) return false;
  let raw: string;
  try { raw = await boundedResponseText(response, 16 * 1024); } catch { return false; }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return imageInputRejected(raw); }
  return imageInputRejected(isObject(body) ? body.error ?? body.detail ?? body : body);
}
