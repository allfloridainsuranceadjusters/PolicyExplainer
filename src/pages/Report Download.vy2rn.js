import wixLocation from "wix-location";
import { fetchReportDownloadUrl } from "backend/reportAccess";

const MAX_ATTEMPTS = 12;
const WAIT_MS = 5000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function setStatus(msg) {
  if ($w("#statusText")) $w("#statusText").text = msg;
}

function showDownloadButton(downloadUrl) {
  $w("#downloadBtn").link = downloadUrl;
  $w("#downloadBtn").target = "_blank";
  $w("#downloadBtn").label = "⬇️ Download Your Report (PDF)";
  if ($w("#downloadBtn").collapsed) $w("#downloadBtn").expand();
}

$w.onReady(async function () {
  console.log("Running the code for the Report Download page.");

  const submissionId = (wixLocation.query.submissionId || "").trim();
  console.log("[REPORT PAGE] submissionId =", submissionId);

  if ($w("#downloadBtn") && !$w("#downloadBtn").collapsed) $w("#downloadBtn").collapse();

  if (!submissionId) {
    setStatus("Missing submissionId. Please use the link from your email.");
    return;
  }

  setStatus("⏳ Preparing your report…");

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const res = await fetchReportDownloadUrl({ submissionId });
    console.log(`[REPORT PAGE] attempt ${i} =>`, res);

    if (res?.ok && res.downloadUrl) {
      setStatus("✅ Your report is ready.");
      showDownloadButton(res.downloadUrl);
      return;
    }

    setStatus(`⏳ ${res?.error || "Report not ready yet."} (attempt ${i}/${MAX_ATTEMPTS})`);
    await sleep(WAIT_MS);
  }

  setStatus("⚠️ Taking longer than expected. Please refresh in 1–2 minutes.");
});
