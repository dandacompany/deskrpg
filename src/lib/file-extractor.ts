/**
 * file-extractor.ts
 * Extracts text/image content from uploaded files for NPC chat attachments.
 * Images are resized and sent as gateway attachments (multimodal vision).
 * Text-based files (PDF, XLSX, DOCX) are extracted and inlined in the message.
 */

import { promptLocale, type PromptLocale } from "@/lib/i18n/prompt-locale";
import { normalizeLocale } from "@/lib/i18n/server";

// ─── Constants ───────────────────────────────────────────────────────

export const FILE_LIMITS = {
  maxFileSize: 5 * 1024 * 1024, // 5 MB
  maxFileCount: 3,
  maxTextLength: 50_000,
} as const;

const ALLOWED_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".pdf",
  ".xlsx",
  ".xls",
  ".docx",
  ".doc",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

// ─── Helpers ─────────────────────────────────────────────────────────

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

export function isAllowedFileType(name: string, _mimeType: string): boolean {
  return ALLOWED_EXTENSIONS.has(extOf(name));
}

// ─── Types ───────────────────────────────────────────────────────────

export interface ExtractedFile {
  name: string;
  mimeType: string;
  textContent: string | null;
  /** Raw base64 image data (no data URI prefix) */
  imageBase64: string | null;
  truncated: boolean;
}

/** Attachment format sent to the gateway. */
export interface GatewayAttachment {
  type: "image";
  mimeType: string;
  fileName: string;
  content: string; // raw base64
}

// ─── Wording ─────────────────────────────────────────────────────────

/** Text inlined into the message for the NPC. `ko` is the original wording; every other language gets `en`. */
type Locale = string | null | undefined;

const WORDS: Record<
  PromptLocale,
  {
    truncated: (total: string, limit: string) => string;
    unsupported: string;
    failed: (name: string, msg: string) => string;
    attachment: string;
  }
> = {
  ko: {
    truncated: (total, limit) => `(... 이하 생략, 총 ${total}자 중 ${limit}자 표시)`,
    unsupported: "지원하지 않는 파일 형식입니다.",
    failed: (name, msg) => `[파일 처리 오류: ${name}] ${msg}`,
    attachment: "📎 첨부파일",
  },
  en: {
    truncated: (total, limit) => `(... truncated, showing ${limit} of ${total} characters)`,
    unsupported: "Unsupported file type.",
    failed: (name, msg) => `[File processing error: ${name}] ${msg}`,
    attachment: "📎 Attachment",
  },
};

// ─── Truncation ──────────────────────────────────────────────────────

function truncateText(text: string, locale: Locale): { text: string; truncated: boolean } {
  if (text.length <= FILE_LIMITS.maxTextLength) {
    return { text, truncated: false };
  }
  // Format numbers in the reader's locale, never the server's — the output must not depend on the host.
  const numberLocale = promptLocale(locale) === "ko" ? "ko-KR" : normalizeLocale(locale);
  const total = text.length.toLocaleString(numberLocale);
  const limit = FILE_LIMITS.maxTextLength.toLocaleString(numberLocale);
  const truncated = text.slice(0, FILE_LIMITS.maxTextLength);
  return {
    text: `${truncated}\n\n${WORDS[promptLocale(locale)].truncated(total, limit)}`,
    truncated: true,
  };
}

// ─── Extraction ──────────────────────────────────────────────────────

async function extractText(buffer: Buffer): Promise<string> {
  return buffer.toString("utf-8");
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  return result.text;
}

async function extractXlsx(buffer: Buffer): Promise<string> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buffer, { type: "buffer" });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    parts.push(`[Sheet: ${name}]\n${csv}`);
  }
  return parts.join("\n\n");
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractImage(buffer: Buffer): Promise<string> {
  const sharp = (await import("sharp")).default;
  const resized = await sharp(buffer)
    .resize({ width: 1024, height: 1024, fit: "inside" })
    .jpeg({ quality: 80 })
    .toBuffer();
  return resized.toString("base64");
}

// ─── Main extract function ───────────────────────────────────────────

export async function extractFileContent(
  buffer: Buffer,
  name: string,
  mimeType: string,
  locale: Locale = "ko",
): Promise<ExtractedFile> {
  const words = WORDS[promptLocale(locale)];
  try {
    const ext = extOf(name);

    // Images → resize and base64 encode for multimodal vision
    if (mimeType.startsWith("image/")) {
      const base64 = await extractImage(buffer);
      return {
        name,
        mimeType: "image/jpeg",
        textContent: null,
        imageBase64: base64,
        truncated: false,
      };
    }

    // Text-based files
    let rawText: string | null = null;

    if ([".txt", ".md", ".json", ".csv"].includes(ext)) {
      rawText = await extractText(buffer);
    } else if (ext === ".pdf") {
      rawText = await extractPdf(buffer);
    } else if (ext === ".xlsx" || ext === ".xls") {
      rawText = await extractXlsx(buffer);
    } else if (ext === ".docx" || ext === ".doc") {
      rawText = await extractDocx(buffer);
    } else {
      return {
        name,
        mimeType,
        textContent: words.unsupported,
        imageBase64: null,
        truncated: false,
      };
    }

    const { text, truncated } = truncateText(rawText, locale);
    return { name, mimeType, textContent: text, imageBase64: null, truncated };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name,
      mimeType,
      textContent: words.failed(name, msg),
      imageBase64: null,
      truncated: false,
    };
  }
}

// ─── Prompt builder (text files only) ───────────────────────────────

export function buildFilePromptSection(files: ExtractedFile[], locale: Locale = "ko"): string {
  if (files.length === 0) return "";
  const label = WORDS[promptLocale(locale)].attachment;

  const sections = files
    .filter((f) => f.textContent) // skip images — they go via attachments
    .map((f) => `${label}: ${f.name}\n\`\`\`\n${f.textContent}\n\`\`\``);

  if (sections.length === 0) return "";
  return "\n\n" + sections.join("\n\n");
}

// ─── Attachment builder (images only) ───────────────────────────────

export function buildAttachments(files: ExtractedFile[]): GatewayAttachment[] | undefined {
  const images = files.filter((f) => f.imageBase64);
  if (images.length === 0) return undefined;
  return images.map((f) => ({
    type: "image" as const,
    mimeType: f.mimeType,
    fileName: f.name,
    content: f.imageBase64!,
  }));
}
