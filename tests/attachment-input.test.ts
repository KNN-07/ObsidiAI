import { describe, expect, it } from "vitest";
import { isLargePaste, readAttachmentFile } from "../src/ui/attachment-input";
import { deflateSync } from "node:zlib";

function pdfFile(pages: string[], name = "document.pdf"): File {
 const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
 ];
 for (const [index, text] of pages.entries()) {
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
  const stream = deflateSync(Buffer.from(`BT /F1 0.001 Tf 50 700 Td (${text}) Tj ET`)).toString("latin1");
  objects.push(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n${stream}\nendstream`);
 }
 let body = "%PDF-1.7\n";
 const offsets = [0];
 for (const [index, object] of objects.entries()) {
  offsets.push(body.length);
  body += `${index + 1} 0 obj\n${object}\nendobj\n`;
 }
 const xref = body.length;
 body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
 body += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
 body += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
 return new File([Buffer.from(body, "latin1")], name, { type: "application/pdf" });
}

describe("computer attachment inputs", () => {
 it("accepts UTF-8 source despite an operating-system media MIME and keeps only its basename", async () => {
  const source = "export const answer: number = 42;\n";
  const file = new File(["\ufeff", source], "C:\\private\\example.ts", { type: "video/mp2t" });
  expect(await readAttachmentFile(file)).toEqual({ kind: "text", path: "example.ts", content: source });
 });
 it("rejects binary and malformed UTF-8 rather than silently changing the attached text", async () => {
  await expect(readAttachmentFile(new File([new Uint8Array([0, 65])], "binary.txt"))).rejects.toThrow("Binary");
  await expect(readAttachmentFile(new File([new Uint8Array([0xc3, 0x28])], "broken.txt"))).rejects.toThrow("UTF-8");
 });
 it("rejects image bytes whose advertised format disagrees", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await expect(readAttachmentFile(new File([png], "photo.jpg", { type: "image/jpeg" }))).rejects.toThrow("match");
 });
 it("extracts compressed PDF pages in order as previewable text with only the basename", async () => {
  const attachment = await readAttachmentFile(pdfFile(["First page", "Second page"], "C:\\private\\report.pdf"));
  expect(attachment).toEqual({ kind: "text", path: "report.pdf", content: "First page\n\nSecond page" });
 });
 it("rejects forged, damaged, and mislabeled PDFs", async () => {
  await expect(readAttachmentFile(new File(["not a PDF"], "fake.pdf"))).rejects.toThrow("signature");
  await expect(readAttachmentFile(new File(["%PDF-1.7\nbroken"], "broken.pdf"))).rejects.toThrow("Could not read PDF");
  await expect(readAttachmentFile(pdfFile(["Hello"], "wrong.txt"))).rejects.toThrow("match");
 });
 it("rejects PDFs without extractable text rather than attaching empty context", async () => {
  await expect(readAttachmentFile(pdfFile([""]))).rejects.toThrow("OCR");
 });
 it("rejects oversized extracted text and excessive page counts without truncation", async () => {
  await expect(readAttachmentFile(pdfFile(["a".repeat(200_001)]))).rejects.toThrow("200,000");
  await expect(readAttachmentFile(pdfFile(Array(501).fill("")))).rejects.toThrow("500 pages");
 });
 it("rejects oversized PDF bytes before parsing", async () => {
  await expect(readAttachmentFile(new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.pdf"))).rejects.toThrow("20 MiB");
 });
 it("counts CRLF as one line when deciding whether to attach a paste", () => {
  expect(isLargePaste(Array(39).fill("line").join("\r\n"))).toBe(false);
  expect(isLargePaste(Array(40).fill("line").join("\r\n"))).toBe(true);
 });
});
