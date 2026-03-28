// backend/policyEmailer.js
import { triggeredEmails } from "wix-crm-backend";

const REPORT_PAGE_BASE_URL = "https://www.allfloridainsuranceadjusters.com/report";

/**
 * Sends the Triggered Email with a clean report link.
 */
export async function sendPolicyReportEmail({
  contactId,
  firstName,
  submissionId,
  reportUrl,      // optional direct PDF
  reportPdfName,  // optional
} = {}) {
  if (!contactId) throw new Error("Missing contactId");
  if (!submissionId) throw new Error("Missing submissionId");

  const reportLink = `${REPORT_PAGE_BASE_URL}?submissionId=${encodeURIComponent(submissionId)}`;

  const emailId = "PolicyExplainerReport";

  await triggeredEmails.emailContact(emailId, contactId, {
    variables: {
      firstName: firstName || "",
      reportLink,
      submissionId,
      reportPdfName: reportPdfName || "Policy-Explainer-Report.pdf",
      reportUrl: reportUrl || "",
    },
  });

  return { ok: true, reportLink };
}
