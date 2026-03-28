// backend/runLogger.js
import wixData from "wix-data";

const COLLECTION = "PolicyExplainerRuns";

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return JSON.stringify({ error: "Could not stringify", message: String(e) });
  }
}

async function getByRunId(runId) {
  const res = await wixData
    .query(COLLECTION)
    .eq("runId", runId)
    .limit(1)
    .find({ suppressAuth: true });

  return res.items?.[0] || null;
}

export async function createRunLog({ payload }) {
  const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const item = {
    title: `Run ${runId}`, // keep Wix happy (Title exists)
    runId,

    submissionId: payload?.submissionId || "",
    formId: payload?.formId || "",
    formName: payload?.formName || "",
    email: payload?.email || "",
    contactId: payload?.contactId || "",

    status: "STARTED",
    step: "RECEIVED",

    policyFileUrl: payload?.policyFileUrl || "",
    policyFileName: payload?.policyFileName || "",
    reportUrl: "",

    errorMessage: "",
    payloadJson: safeStringify(payload),

    createdAt: new Date(),
    updatedAt: new Date()
  };

  await wixData.insert(COLLECTION, item, { suppressAuth: true });
  return runId;
}

export async function updateRunLog(runId, patch = {}) {
  const existing = await getByRunId(runId);
  if (!existing) return;

  const updated = {
    ...existing,
    ...patch,
    updatedAt: new Date()
  };

  if (!updated.title) updated.title = `Run ${runId}`;

  if (patch.payloadJson && typeof patch.payloadJson !== "string") {
    updated.payloadJson = safeStringify(patch.payloadJson);
  }

  await wixData.update(COLLECTION, updated, { suppressAuth: true });
}

export async function failRunLog(runId, err, step = "FAILED") {
  await updateRunLog(runId, {
    status: "ERROR",
    step,
    errorMessage: String(err?.message || err || "Unknown error")
  });
}

export async function successRunLog(runId, { reportUrl } = {}) {
  await updateRunLog(runId, {
    status: "SUCCESS",
    step: "DONE",
    reportUrl: reportUrl || ""
  });
}
