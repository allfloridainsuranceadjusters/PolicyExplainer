// backend/policyPdfGenerator.js
import { fetch } from "wix-fetch";
import { mediaManager } from "wix-media-backend";
import { getSecret } from "wix-secrets-backend";

const DEFAULT_FOLDER = "/policy-explainer-reports";

function sanitizeFileName(name = "Policy-Explainer-Report") {
  return String(name)
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function safeStr(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

/**
 * Option C Renderer: calls Render (Playwright HTML->PDF) and uploads to Wix Media.
 *
 * Expects:
 *  - reportData: STRICT JSON object
 *  - meta: { name, email }
 *  - branding: { logoUrl, company }
 */
export async function generateAndUploadReportPdf({
  runId = "",
  reportData = null,
  meta = {},
  branding = {},
} = {}) {
  if (!reportData || typeof reportData !== "object") {
    throw new Error("Missing reportData for PDF rendering.");
  }

  const renderBaseUrl = await getSecret("RENDER_PDF_URL"); // store like: https://policy-pdf-renderer.onrender.com
  if (!renderBaseUrl) {
    throw new Error("Missing RENDER_PDF_URL secret in Wix Secrets Manager.");
  }

  const renderUrl = joinUrl(renderBaseUrl, "/render");

  const safeRunId = safeStr(runId, "").trim() || `${Date.now()}`;
  const baseName = sanitizeFileName(`Policy-Explainer-Report-${safeRunId}`);
  const fileName = `${baseName}.pdf`;

  // Call Render
  const resp = await fetch(renderUrl, {
    method: "post",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reportData,
      meta: {
        name: safeStr(meta?.name, ""),
        email: safeStr(meta?.email, ""),
      },
      branding: {
        // Your header image URL (full-width header PNG)
        logoUrl: safeStr(branding?.logoUrl, ""),
        company: branding?.company || {},
      },
    }),
  });

  if (!resp.ok) {
    const errText = await safeReadText(resp);
    throw new Error(`Render PDF service error (${resp.status}): ${errText}`);
  }

  // Wix backend fetch: use buffer(), not arrayBuffer()
  const pdfBuf = await resp.buffer();

  // Upload to Wix Media
  let uploadRes;
  try {
    uploadRes = await mediaManager.upload(DEFAULT_FOLDER, pdfBuf, fileName, {
      mediaOptions: {
        mimeType: "application/pdf",
        mediaType: "document",
      },
      metadataOptions: { isPrivate: false },
    });
  } catch (e) {
    uploadRes = await mediaManager.upload(DEFAULT_FOLDER, pdfBuf, fileName);
  }

  const fileUrl = uploadRes?.fileUrl || uploadRes?.url || uploadRes?.mediaUrl || "";
  const downloadUrl = uploadRes?.downloadUrl || fileUrl;

  return { fileName, fileUrl, downloadUrl };
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch (e) {
    try {
      const b = await res.buffer();
      return b ? String(b) : "";
    } catch (_) {
      return "";
    }
  }
}
