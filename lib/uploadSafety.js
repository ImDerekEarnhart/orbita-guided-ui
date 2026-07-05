"use strict";

const MAX_CSV_UPLOAD_BYTES = 50 * 1024 * 1024;

const ALLOWED_FILE_MIME_TYPES = new Set([
  "",
  "application/csv",
  "application/octet-stream",
  "application/vnd.ms-excel",
  "text/csv",
  "text/plain",
  "text/x-csv",
]);

const DANGEROUS_EXTENSIONS = new Set([
  "bat", "bin", "cmd", "com", "dll", "dmg", "elf", "exe", "jar",
  "js", "jsx", "msi", "php", "ps1", "py", "scr", "sh", "so",
  "tar", "tgz", "ts", "vbs", "war", "z", "zip", "7z", "rar",
]);

function fail(status, error) {
  return { ok: false, status, error };
}

function headerValue(headers, name) {
  const direct = headers?.[name] || headers?.[name.toLowerCase()] || headers?.[name.toUpperCase()];
  if (Array.isArray(direct)) return direct[0] || "";
  return direct || "";
}

function getMultipartBoundary(contentType) {
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  const boundary = (match?.[1] || match?.[2] || "").trim();
  if (!boundary || boundary.length > 200) return "";
  return boundary;
}

function parsePartHeaders(headerText) {
  const headers = {};
  for (const line of headerText.split(/\r\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

function parseHeaderParam(value, name) {
  const re = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|[^;]*)`, "i");
  const match = re.exec(value || "");
  if (!match) return "";
  let raw = match[1].trim();
  if (raw.startsWith("\"") && raw.endsWith("\"")) {
    raw = raw.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return raw;
}

function extractFilePart(contentType, body) {
  const boundary = getMultipartBoundary(contentType);
  if (!boundary) return fail(400, "Upload must be multipart/form-data.");

  const raw = body.toString("latin1");
  const sections = raw.split(`--${boundary}`);
  let filePart = null;

  for (let section of sections) {
    if (!section || section === "--" || section === "--\r\n") continue;
    if (section.startsWith("\r\n")) section = section.slice(2);
    if (section.endsWith("--\r\n")) section = section.slice(0, -4);
    if (section.endsWith("--")) section = section.slice(0, -2);

    const headerEnd = section.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const headers = parsePartHeaders(section.slice(0, headerEnd));
    const disposition = headers["content-disposition"] || "";
    const filename = parseHeaderParam(disposition, "filename");
    const filenameStar = parseHeaderParam(disposition, "filename\\*");
    if (!filename && !filenameStar) continue;

    if (filePart) return fail(400, "Upload must contain exactly one file.");

    let content = section.slice(headerEnd + 4);
    if (content.endsWith("\r\n")) content = content.slice(0, -2);
    filePart = {
      filename: filename || filenameStar,
      contentType: (headers["content-type"] || "").split(";")[0].trim().toLowerCase(),
      bytes: Buffer.from(content, "latin1"),
    };
  }

  if (!filePart) return fail(400, "Upload must include one CSV file.");
  return { ok: true, file: filePart };
}

function validateFilename(filename) {
  const raw = String(filename || "");
  if (!raw || raw.length > 120) return "Filename must be 1-120 characters.";
  if (raw !== raw.trim()) return "Filename must not start or end with spaces.";
  if (/[\x00-\x1f\x7f]/.test(raw)) return "Filename contains control characters.";
  if (raw.includes("/") || raw.includes("\\") || raw.includes(":")) {
    return "Filename must not include a path.";
  }
  if (raw.includes("..") || raw.startsWith(".")) return "Filename is not allowed.";
  if (!/^[A-Za-z0-9][A-Za-z0-9._() -]*$/.test(raw)) {
    return "Filename contains unsupported characters.";
  }

  const parts = raw.toLowerCase().split(".");
  if (parts.length < 2 || parts.at(-1) !== "csv") return "Only .csv files are allowed.";
  if (parts.slice(0, -1).some(part => DANGEROUS_EXTENSIONS.has(part))) {
    return "Filename includes a blocked executable or archive extension.";
  }
  return "";
}

function hasMagic(bytes, magic) {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

function sniffCsvContent(bytes) {
  if (!bytes.length) return "CSV file is empty.";

  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  const magics = [
    [0x4d, 0x5a],                   // Windows PE executable
    [0x7f, 0x45, 0x4c, 0x46],       // ELF
    [0x50, 0x4b, 0x03, 0x04],       // ZIP/JAR/XLSX
    [0x50, 0x4b, 0x05, 0x06],
    [0x50, 0x4b, 0x07, 0x08],
    [0x1f, 0x8b],                   // gzip
    [0x25, 0x50, 0x44, 0x46],       // PDF
    [0x89, 0x50, 0x4e, 0x47],       // PNG
    [0xff, 0xd8, 0xff],             // JPEG
    [0x52, 0x61, 0x72, 0x21],       // RAR
    [0x37, 0x7a, 0xbc, 0xaf],       // 7z
  ];
  if (magics.some(magic => hasMagic(sample, magic))) {
    return "File content does not look like CSV.";
  }
  if (hasMagic(sample, [0x23, 0x21])) return "Scripts are not allowed.";
  if (sample.includes(0)) return "Binary files are not allowed.";

  let controls = 0;
  for (const b of sample) {
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) controls += 1;
  }
  if (controls / sample.length > 0.01) return "Binary files are not allowed.";

  const text = sample.toString("utf8").trimStart();
  if (/^<(?:!doctype|html|script|svg|xml)\b/i.test(text)) {
    return "HTML or script content is not allowed.";
  }
  if (!/[,\t;]/.test(text)) return "CSV must include a delimited header row.";
  return "";
}

function countRows(bytes) {
  const text = bytes.toString("utf8");
  if (!text) return 0;
  return text.split(/\r\n|\n|\r/).filter(line => line.length > 0).length;
}

function validateCsvUpload({ headers, body, maxBytes = MAX_CSV_UPLOAD_BYTES }) {
  if (!Buffer.isBuffer(body)) return fail(400, "Upload body is invalid.");
  if (body.length > maxBytes) {
    return fail(413, `File too large. Maximum is ${Math.round(maxBytes / 1048576)} MB.`);
  }

  const contentType = headerValue(headers, "content-type");
  const extracted = extractFilePart(contentType, body);
  if (!extracted.ok) return extracted;

  const { file } = extracted;
  const filenameError = validateFilename(file.filename);
  if (filenameError) return fail(400, filenameError);
  if (!ALLOWED_FILE_MIME_TYPES.has(file.contentType)) {
    return fail(400, "CSV upload has an unsupported content type.");
  }

  const contentError = sniffCsvContent(file.bytes);
  if (contentError) return fail(400, contentError);

  return {
    ok: true,
    filename: file.filename,
    contentType: file.contentType,
    bytes: file.bytes.length,
    rowCount: countRows(file.bytes),
  };
}

module.exports = {
  MAX_CSV_UPLOAD_BYTES,
  validateCsvUpload,
  validateFilename,
  sniffCsvContent,
};
