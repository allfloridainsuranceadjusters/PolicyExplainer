// backend/reportDownload.web.js
import wixData from "wix-data";

const COLLECTION_ID = "PolicyExplainerRuns";

export async function fetchReportUrl(submissionId) {
  try {
    const sid = String(submissionId || "").trim();
    if (!sid) return { ok: false, error: "Missing submissionId." };

    const res = await wixData
      .query(COLLECTION_ID)
      .eq("submissionId", sid)
      .descending("_createdDate")
      .limit(1)
      .find({ suppressAuth: true });

    const item = res.items?.[0];
    if (!item) return { ok: false, error: "No report found for this link." };

    const reportUrl = item.reportUrl || "";
    if (!reportUrl) return { ok: false, error: "Report not ready yet. Try again in 1 minute." };

    return { ok: true, reportUrl };
  } catch (e) {
    console.error("[fetchReportUrl] error:", e);
    return { ok: false, error: "Server error loading report." };
  }
}
