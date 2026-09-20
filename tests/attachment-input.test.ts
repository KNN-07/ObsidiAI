import { describe, expect, it } from "vitest";
import { isLargePaste, readAttachmentFile } from "../src/ui/attachment-input";

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
 it("counts CRLF as one line when deciding whether to attach a paste", () => {
  expect(isLargePaste(Array(39).fill("line").join("\r\n"))).toBe(false);
  expect(isLargePaste(Array(40).fill("line").join("\r\n"))).toBe(true);
 });
});
