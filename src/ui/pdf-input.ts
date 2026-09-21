import { MAX_TEXT_CHARACTERS } from "../agent/attachments";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
class PdfInputError extends Error {}

/** Extract only text: no page rendering, scripts, attachments, or external resources. */
export async function extractPdfText(data: Uint8Array): Promise<string> {
 // Static initialization would run before the host Node-version check and file selection.
 const { getDocument } = await import("unpdf/pdfjs");
 const task = getDocument({
  data, useWorkerFetch: false, disableFontFace: true,
  useSystemFonts: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
  stopAtErrors: true, verbosity: 0
 });
 try {
  const pdf = await task.promise;
  if (pdf.numPages > MAX_PDF_PAGES) throw new PdfInputError("PDFs must contain at most 500 pages.");
  const parts: string[] = [];
  let length = 0;
  const append = (text: string): void => {
   length += text.length;
   if (length > MAX_TEXT_CHARACTERS) return;
   parts.push(text);
  };
  for (let number = 1; number <= pdf.numPages; number++) {
   if (number > 1) append("\n\n");
   const page = await pdf.getPage(number);
   const reader = page.streamTextContent().getReader();
   try {
    while (true) {
     const { done, value } = await reader.read();
     if (done) break;
     for (const item of value.items) {
      if (!("str" in item)) continue;
      append(item.str);
      if (item.hasEOL) append("\n");
     }
    }
   } finally {
    reader.releaseLock();
    page.cleanup();
   }
   if (length > MAX_TEXT_CHARACTERS) throw new PdfInputError("PDF text exceeds 200,000 characters; it was not attached.");
  }
  const text = parts.join("").trim();
  if (!text) throw new PdfInputError("This PDF has no extractable text. Scanned PDFs need OCR before attaching.");
  return text;
 } catch (error) {
  if (error instanceof PdfInputError) throw error;
  throw new Error("Could not read PDF. It may be damaged, password-protected, or unsupported.");
 } finally {
  await task.destroy();
 }
}
