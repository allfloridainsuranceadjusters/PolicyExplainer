// backend/events.js
import wixData from "wix-data";

const COLLECTION_ID = "PolicyExplainerRuns";
const PIPELINE_VERSION = "EVENTS_V8_PROOFSTAMP_20260131";

const FIELD_REPORT_URL = "reportUrl";
const FIELD_REPORT_PDF_NAME = "reportPdfName";

const HEADER_LOGO_URL =
  "https://static.wixstatic.com/media/c5554f_804cd8f5df3b4f8dadc4b7c8a028623d~mv2.png";

function pick(obj, key, fallback = "") {
  const v = obj?.[key];
  return typeof v === "string" ? v.trim() : fallback;
}
function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return JSON.stringify({ error: "Could not stringify", message: String(e) });
  }
}
function safeParse(jsonStr) {
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

function pushStep(payloadObj, step, extra = {}) {
  if (!payloadObj.pipelineStepLog || !Array.isArray(payloadObj.pipelineStepLog)) {
    payloadObj.pipelineStepLog = [];
  }
  payloadObj.pipelineStepLog.push({
    at: new Date().toISOString(),
    step,
    ...extra,
  });
}

async function findExistingBySubmissionId(submissionId) {
  if (!submissionId) return null;
  const res = await wixData
    .query(COLLECTION_ID)
    .eq("submissionId", submissionId)
    .limit(1)
    .find({ suppressAuth: true });
  return res.items?.[0] || null;
}

async function upsert(runItem) {
  return wixData.update(COLLECTION_ID, runItem, { suppressAuth: true });
}

export async function invoke(payload) {
  let runItem = null;

  try {
    const p = payload?.payload || payload?.data || payload || {};

    const firstName = pick(p, "field:first_name_da43");
    const lastName = pick(p, "field:last_name_f246");
    const email = pick(p, "field:email_df91");

    const uploadArr = p["field:policy_upload"];
    const policyFileUrl =
      Array.isArray(uploadArr) && uploadArr.length > 0 ? uploadArr[0]?.url || "" : "";
    const policyFileName =
      Array.isArray(uploadArr) && uploadArr.length > 0
        ? uploadArr[0]?.displayName || uploadArr[0]?.fileId || ""
        : "";

    const submissionId = pick(p, "submissionId");
    const contactId = pick(p, "contactId");

    // ✅ keep these if provided
    const formName = pick(p, "formName");
    const formId = pick(p, "formId");

    const normalized = {
      firstName,
      lastName,
      name: `${firstName} ${lastName}`.trim(),
      email,
      policyFileUrl,
      policyFileName,
      submissionId,
      contactId,
      formName,
      formId,
    };

    const now = new Date();

    // A) ensure run exists
    runItem = await findExistingBySubmissionId(submissionId);
    if (!runItem) {
      const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const basePayload = { ...normalized, pipelineVersion: PIPELINE_VERSION, pipelineStepLog: [] };
      pushStep(basePayload, "CREATED_RUN");

      runItem = await wixData.insert(
        COLLECTION_ID,
        {
          title: `Run ${runId}`,
          runId,
          submissionId: normalized.submissionId || "",
          email: normalized.email || "",
          contactId: normalized.contactId || "",
          policyFileUrl: normalized.policyFileUrl || "",
          policyFileName: normalized.policyFileName || "",
          formName: normalized.formName || "",
          formId: normalized.formId || "",
          status: "QUEUED",
          step: "READY_FOR_AI",
          [FIELD_REPORT_URL]: "",
          [FIELD_REPORT_PDF_NAME]: "",
          errorMessage: "",
          payloadJson: safeStringify(basePayload),
          createdAt: now,
          updatedAt: now,
        },
        { suppressAuth: true }
      );
    } else {
      runItem.updatedAt = now;
      await upsert(runItem);
      runItem = await findExistingBySubmissionId(submissionId);
    }

    // Load payloadJson and stamp proof markers even for existing runs
    let payloadObj = safeParse(runItem.payloadJson) || { ...normalized };
    payloadObj.pipelineVersion = PIPELINE_VERSION;
    pushStep(payloadObj, "INVOKE_START");

    runItem.payloadJson = safeStringify(payloadObj);
    runItem.updatedAt = new Date();
    await upsert(runItem);

    // B) AI -> reportData (Option B in policyReport.js)
    payloadObj = safeParse((await findExistingBySubmissionId(submissionId)).payloadJson) || payloadObj;

    const alreadyHasReportData = !!payloadObj.reportData;
    if (runItem.step === "READY_FOR_AI" && !alreadyHasReportData) {
      runItem.status = "PROCESSING";
      runItem.step = "AI_GENERATING";
      runItem.errorMessage = "";
      runItem.updatedAt = new Date();
      await upsert(runItem);

      pushStep(payloadObj, "AI_START");
      runItem.payloadJson = safeStringify(payloadObj);
      await upsert(runItem);

      const { generateReportDataFromPdfUrl } = await import("backend/policyReport");

      const ai = await generateReportDataFromPdfUrl({
        policyFileUrl,
        firstName,
        policyFileName,
        state: "Florida",
      });

      if (!ai?.ok || !ai?.reportData) throw new Error("AI did not return reportData JSON.");

      // ✅ persist reportData
      payloadObj = safeParse((await findExistingBySubmissionId(submissionId)).payloadJson) || payloadObj;
      payloadObj.reportData = ai.reportData;
      payloadObj.aiRaw = ai.aiRaw || "";
      payloadObj.buildTag = ai.buildTag || "";
      pushStep(payloadObj, "AI_DONE", {
        hasInsured: !!ai.reportData?.insuredName,
        hasAddress: !!ai.reportData?.propertyAddress,
        coverageCount: ai.reportData?.atAGlance?.coverages?.length || 0,
      });

      runItem = await findExistingBySubmissionId(submissionId);
      runItem.payloadJson = safeStringify(payloadObj);
      runItem.status = "AI_COMPLETE";
      runItem.step = "READY_FOR_PDF";
      runItem.updatedAt = new Date();
      await upsert(runItem);
    }

    // C) PDF
    runItem = await findExistingBySubmissionId(submissionId);
    payloadObj = safeParse(runItem.payloadJson) || payloadObj;

    const alreadyHasReportUrl =
      !!runItem?.[FIELD_REPORT_URL] && String(runItem[FIELD_REPORT_URL]).trim().length > 0;

    if (runItem.step === "READY_FOR_PDF" && !alreadyHasReportUrl) {
      runItem.status = "PROCESSING";
      runItem.step = "PDF_GENERATING";
      runItem.errorMessage = "";
      runItem.updatedAt = new Date();
      await upsert(runItem);

      const { generateAndUploadReportPdf } = await import("backend/policyPdfGenerator");

      if (!payloadObj.reportData) throw new Error("Missing reportData in payloadJson at PDF step.");

      pushStep(payloadObj, "PDF_START");
      runItem.payloadJson = safeStringify(payloadObj);
      await upsert(runItem);

      const pdfRes = await generateAndUploadReportPdf({
        runId: runItem.runId,
        name: normalized.name,
        email: normalized.email,
        reportData: payloadObj.reportData,
        logoUrl: HEADER_LOGO_URL,
      });

      const finalUrl = pdfRes?.downloadUrl || pdfRes?.fileUrl || "";
      const finalName = pdfRes?.fileName || "";

      pushStep(payloadObj, "PDF_DONE", { finalName, hasUrl: !!finalUrl });

      runItem = await findExistingBySubmissionId(submissionId);
      runItem.payloadJson = safeStringify(payloadObj);
      runItem[FIELD_REPORT_URL] = finalUrl;
      runItem[FIELD_REPORT_PDF_NAME] = finalName;
      runItem.status = "PDF_READY";
      runItem.step = "READY_FOR_EMAIL";
      runItem.updatedAt = new Date();
      await upsert(runItem);
    }

    // D) EMAIL
    runItem = await findExistingBySubmissionId(submissionId);
    if (runItem.step === "READY_FOR_EMAIL") {
      runItem.status = "PROCESSING";
      runItem.step = "EMAIL_SENDING";
      runItem.errorMessage = "";
      runItem.updatedAt = new Date();
      await upsert(runItem);

      const { sendPolicyReportEmail } = await import("backend/policyEmailer");

      await sendPolicyReportEmail({
        contactId: runItem.contactId,
        firstName: normalized.firstName,
        submissionId: runItem.submissionId,
        reportUrl: runItem[FIELD_REPORT_URL],
        reportPdfName: runItem[FIELD_REPORT_PDF_NAME],
      });

      payloadObj = safeParse((await findExistingBySubmissionId(submissionId)).payloadJson) || payloadObj;
      pushStep(payloadObj, "EMAIL_DONE");
      runItem = await findExistingBySubmissionId(submissionId);
      runItem.payloadJson = safeStringify(payloadObj);
      runItem.status = "EMAIL_SENT";
      runItem.step = "DONE";
      runItem.updatedAt = new Date();
      await upsert(runItem);
    }

    return {};
  } catch (err) {
    try {
      if (runItem?._id) {
        runItem.status = "ERROR";
        runItem.step = "PIPELINE_FAILED";
        runItem.errorMessage = String(err?.message || err);
        runItem.updatedAt = new Date();
        await wixData.update(COLLECTION_ID, runItem, { suppressAuth: true });
      }
    } catch (e) {}
    return {};
  }
}
