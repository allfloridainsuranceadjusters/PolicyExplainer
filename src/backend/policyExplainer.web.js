// backend/policyExplainer.web.js
// FULL-FILE REPLACEMENT (single authoritative pipeline)

import wixData from "wix-data";

import { extractPolicyTextFromUrl } from "backend/policyTextExtractor.js";
import { generateReportFromPolicyTextAndUploadPdf } from "backend/policyReport.js";
import { sendPolicyReportEmail } from "backend/policyEmailer.js";

const RUNS_COLLECTION = "PolicyExplainerRuns";

export async function submitPolicyForReport(payload = {}) {
  console.log("submitPolicyForReport RECEIVED:", JSON.stringify(payload));

  const submissionId = payload.submissionId;
  if (!submissionId) return { ok: false, error: "Missing submissionId in payload." };

  // 1) Find (or create) the run record
  let run = await getRunBySubmissionId(submissionId);
  if (!run) run = await createRunRecord(payload);

  // 2) EXTRACT (only if missing)
  try {
    if (!run.policyText || !String(run.policyText).trim()) {
      await patchRun(run._id, {
        status: "PROCESSING",
        step: "EXTRACTING_TEXT",
        errorMessage: "",
      });

      const extracted = await extractPolicyTextFromUrl(payload.policyFileUrl);
      if (!extracted?.ok) throw new Error(extracted?.error || "Extractor returned ok:false");

      await patchRun(run._id, {
        policyText: extracted.text,
        policyTextCharCount: extracted.charCount || (extracted.text?.length || 0),
        status: "PROCESSING",
        step: "TEXT_EXTRACTED",
      });

      run = await wixData.get(RUNS_COLLECTION, run._id, { suppressAuth: true });
    }
  } catch (err) {
    const msg = `EXTRACT_FAILED: ${String(err?.message || err)}`;
    console.log(msg);
    await patchRun(run._id, { status: "ERROR", step: "EXTRACT_FAILED", errorMessage: msg });
    return { ok: false, error: msg };
  }

  // 3) AI JSON + PDF (single authoritative path)
  try {
    if (!run.reportUrl || !String(run.reportUrl).trim()) {
      await patchRun(run._id, {
        status: "PROCESSING",
        step: "AI_JSON_AND_PDF",
        errorMessage: "",
      });

      const res = await generateReportFromPolicyTextAndUploadPdf({
        submissionId,
        policyText: run.policyText,
        name: payload.name || payload.firstName || "",
        email: payload.email || "",
        logoUrl: "https://static.wixstatic.com/media/c5554f_804cd8f5df3b4f8dadc4b7c8a028623d~mv2.png",
        company: {
          name: "All Florida Insurance Adjusters",
          phone: "305-874-0653",
          instagram: "@allforidainsuranceadjusters",
          website: "allfloridainsuranceadjusters.com",
        },
      });

      if (!res?.reportUrl) throw new Error(res?.error || "Missing reportUrl from policyReport.");

      await patchRun(run._id, {
        reportUrl: res.reportUrl,
        reportDataJson: JSON.stringify(res.reportData || {}),
        status: "PDF_READY",
        step: "READY_FOR_EMAIL",
      });

      run = await wixData.get(RUNS_COLLECTION, run._id, { suppressAuth: true });
      console.log("✅ PDF reportUrl saved to run:", run.reportUrl);
    } else {
      console.log("ℹ️ reportUrl already exists, skipping AI+PDF generation.");
    }
  } catch (err) {
    const msg = `AI_PDF_FAILED: ${String(err?.message || err)}`;
    console.log(msg);
    await patchRun(run._id, { status: "ERROR", step: "AI_PDF_FAILED", errorMessage: msg });
    return { ok: false, error: msg };
  }

  // 4) EMAIL (optional)
  try {
    await patchRun(run._id, { status: "PROCESSING", step: "EMAIL_SENDING", errorMessage: "" });

    const emailRes = await sendPolicyReportEmail({
      contactId: payload.contactId,
      firstName: payload.firstName || payload.name || "",
      submissionId,
      reportUrl: run.reportUrl,
      reportPdfName: "Policy-Explainer-Report.pdf",
    });

    if (!emailRes?.ok) throw new Error(emailRes?.error || "Email sender returned ok:false");

    await patchRun(run._id, { status: "COMPLETE", step: "DONE" });
  } catch (err) {
    const msg = `EMAIL_FAILED: ${String(err?.message || err)}`;
    console.log(msg);
    await patchRun(run._id, { status: "ERROR", step: "EMAIL_FAILED", errorMessage: msg });
  }

  return { ok: true, submissionId, reportUrl: run.reportUrl };
}

// ----------------- Helpers -----------------

async function getRunBySubmissionId(submissionId) {
  const res = await wixData
    .query(RUNS_COLLECTION)
    .eq("submissionId", submissionId)
    .limit(1)
    .find({ suppressAuth: true });

  return res.items?.[0] || null;
}

async function createRunRecord(payload) {
  const item = {
    submissionId: payload.submissionId,
    firstName: payload.firstName || "",
    lastName: payload.lastName || "",
    name: payload.name || "",
    email: payload.email || "",
    phone: payload.phone || "",
    policyFileUrl: payload.policyFileUrl || "",
    policyFileName: payload.policyFileName || "",
    status: "PROCESSING",
    step: "RECEIVED",
    errorMessage: "",
    runId: payload.runId || "",
  };

  return wixData.insert(RUNS_COLLECTION, item, { suppressAuth: true });
}

async function patchRun(_id, patch) {
  const existing = await wixData.get(RUNS_COLLECTION, _id, { suppressAuth: true });
  const updated = { ...existing, ...patch };
  return wixData.update(RUNS_COLLECTION, updated, { suppressAuth: true });
}
