// backend/policyTextExtractor.js
import { fetch } from "wix-fetch";
import pdfParse from "pdf-parse";

/**
 * Downloads a PDF from a URL and extracts text.
 * Returns { ok: true, text, charCount }
 *
 * IMPORTANT:
 * - wix-fetch Response in Velo supports .buffer()
 * - Avoid .arrayBuffer() to prevent runtime errors
 */

export async function extractTextFromPdfUrl(pdfUrl) {
  if (!pdfUrl || typeof pdfUrl !== "string") {
    throw new Error("extractTextFromPdfUrl: pdfUrl is required.");
  }

  const res = await fetch(pdfUrl);

  if (!res.ok) {
    const body = await safeReadText(res);
    throw new Error(
      `PDF download failed (${res.status} ${res.statusText}). ${body || ""}`.trim()
    );
  }

  const buf = await res.buffer();
  const data = await pdfParse(buf);
  const text = (data?.text || "").trim();

  return { ok: true, text, charCount: text.length };
}

/**
 * Compatibility export (older code expects this name).
 * Same behavior as extractTextFromPdfUrl.
 */
export async function extractPolicyTextFromUrl(pdfUrl) {
  return extractTextFromPdfUrl(pdfUrl);
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch (e) {
    return "";
  }
}
