import { Buffer } from "node:buffer";
import { MAX_IMAGE_BYTES, MAX_TEXT_CHARACTERS, type AttachmentInput, type ImageMime } from "../agent/attachments";

const TEXT_EXTENSIONS = new Set([
 "txt", "text", "md", "markdown", "mdown", "mdx", "rst", "adoc", "csv", "tsv", "json", "jsonc", "jsonl", "ndjson", "yaml", "yml", "toml", "log",
 "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "py", "pyi", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "fs", "fsx",
 "php", "phtml", "lua", "r", "jl", "pl", "pm", "ex", "exs", "erl", "hrl", "hs", "scala", "clj", "cljs", "dart", "vue", "svelte", "astro",
 "html", "htm", "xml", "css", "scss", "sass", "less", "sql", "graphql", "gql", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
 "ini", "cfg", "conf", "config", "properties", "env", "editorconfig", "gitignore", "gitattributes", "gitmodules", "npmrc", "prettierrc", "eslintrc", "dockerignore", "lock", "diff", "patch", "tex", "bib"
]);
const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMime>> = {
 png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif"
};
const TEXT_MIMES = new Set([
 "application/json", "application/ld+json", "application/x-ndjson", "application/jsonl", "application/yaml", "application/x-yaml", "application/toml",
 "application/xml", "application/javascript", "application/x-javascript", "application/typescript", "application/sql", "application/graphql", "application/x-sh"
]);
const GENERIC_MIMES: Readonly<Record<string, true>> = { "": true, "application/octet-stream": true };
const NAMED_TEXT_FILES: Readonly<Record<string, true>> = { dockerfile: true, containerfile: true, makefile: true, gnumakefile: true, "cmakelists.txt": true, jenkinsfile: true, vagrantfile: true, gemfile: true, rakefile: true, procfile: true };

export const FILE_ACCEPT = [
 "text/*", ...TEXT_MIMES, ...Object.values(IMAGE_EXTENSIONS),
 ...Array.from(TEXT_EXTENSIONS, extension => `.${extension}`), ...Object.keys(IMAGE_EXTENSIONS).map(extension => `.${extension}`)
].filter((value, index, values) => values.indexOf(value) === index).join(",");

export function isLargePaste(text: string): boolean {
 if (text.length >= 4000) return true;
 let lines = 1;
 for (let index = 0; index < text.length; index++) {
  if (text[index] === "\r") {
   if (text[index + 1] === "\n") index++;
   lines++;
  } else if (text[index] === "\n") lines++;
  if (lines >= 40) return true;
 }
 return false;
}

function imageSignature(bytes: Uint8Array): ImageMime | undefined {
 if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
 if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
 if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
 if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
 return undefined;
}

export async function readAttachmentFile(file: File): Promise<AttachmentInput> {
 const path = file.name.split(/[\\/]/).pop() || "attachment";
 const name = path.toLowerCase();
 const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
 const mime = file.type.split(";", 1)[0]!.trim().toLowerCase();
 const declaredImage = mime.startsWith("image/") || Object.hasOwn(IMAGE_EXTENSIONS, extension);
 const fail = (message: string): never => { throw new Error(message); };
 if (file.size > Math.max(MAX_IMAGE_BYTES, MAX_TEXT_CHARACTERS * 3 + 3)) fail("File is too large to attach.");
 if (declaredImage && file.size > MAX_IMAGE_BYTES) fail("Images must be 5 MiB or smaller.");
 const signature = imageSignature(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
 if (signature || declaredImage) {
  if (!signature) fail("Unsupported or invalid image. Choose PNG, JPEG, WebP, or GIF.");
  if (file.size > MAX_IMAGE_BYTES) fail("Images must be 5 MiB or smaller.");
  if ((!Object.hasOwn(GENERIC_MIMES, mime) && mime !== signature) || (extension && IMAGE_EXTENSIONS[extension] !== signature)) {
   fail("Image bytes do not match the file type or filename extension.");
  }
  const data = Buffer.from(await file.arrayBuffer()).toString("base64");
  return { kind: "image", path, data, mimeType: signature! };
 }
 if (file.size > MAX_TEXT_CHARACTERS * 3 + 3) fail(`Text attachments must contain at most ${MAX_TEXT_CHARACTERS.toLocaleString()} characters.`);
 const textMime = mime.startsWith("text/") || TEXT_MIMES.has(mime);
 const textName = TEXT_EXTENSIONS.has(extension) || Object.hasOwn(NAMED_TEXT_FILES, name) || (!extension && Object.hasOwn(GENERIC_MIMES, mime));
 // Some platforms classify .ts source as video/mp2t; decoded bytes still must be valid text.
 if (!textMime && !textName) fail("Unsupported file type. Choose a UTF-8 text file or PNG, JPEG, WebP, or GIF image.");
 let content: string;
 try {
  // Fatal decoding rejects malformed UTF-8; the decoder consumes an optional UTF-8 BOM.
  content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
 } catch {
  return fail("Could not read UTF-8 text. Binary files and other text encodings are not supported.");
 }
 if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(content)) fail("Binary/control-byte content is not supported. Choose a UTF-8 text file.");
 if (content.length > MAX_TEXT_CHARACTERS) fail(`Text attachments must contain at most ${MAX_TEXT_CHARACTERS.toLocaleString()} characters.`);
 return { kind: "text", path, content };
}
