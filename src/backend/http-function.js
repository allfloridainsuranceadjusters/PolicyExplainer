// backend/http-functions.js
import { ok, badRequest, forbidden } from "wix-http-functions";
import { submitPolicyForReport } from "backend/policyExplainer.web";

// ✅ Simple shared secret to prevent random spam hitting your endpoint
const WEBHOOK_KEY = "policy-explainer-2026";

function asText(val) {
  return typeof val === "string" ? val.trim() : "";
}

// Tries to find a file URL anywhere in the webhook payload
function findFirstFileUrl(obj) {
  if (!obj || typeof obj !== "object") return null;

  // If it's already a string URL
  if (typeof obj === "string" && obj.startsWith("http")) return obj;

  // Common patterns
  if (obj.url && typeof obj.url === "string") return obj.url;
  if (obj.link && typeof obj.link === "string") return obj.link;
  if (obj.downloadUrl && typeof obj.downloadUrl === "string") return obj.downloadUrl;

  // Arrays
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstFileUrl(item);
      if (found) return found;
    }
  }

  // Nested objects
  for (const v of Object.values(obj)) {
    const found = findFirstFileUrl(v);
    if (found) return found;
  }

  return null;
}

// This endpoint will be called by Wix Automations Webhook
// URL will be: https://allfloridainsuranceadjusters.com/_functions/policyExplainerWebhook?key=policy-explainer-2026
export async function post_policyExplainerWebhook(request) {
  try {
    const key = request.query?.key;
    if (key !== WEBHOOK_KEY) {
      return forbidden({ ok: false, error: "Forbidden" });
    }

    const body = await request.body.json();

    // 🔍 Log raw payload so we can map fields 100% correctly
    console.log("WEBHOOK RAW BODY:", JSON.stringify(body));

    // Try to pull out your known fields (we will refine after first log)
    const firstName = asText(body.firstName || body["First name"] || body["First Name"]);
    const lastName  = asText(body.lastName || body["Last name"] || body["Last Name"]);
    const email     = asText(body.email || body["Email"]);
    const phone     = asText(body.phone || body["Phone"]);

    // Find the uploaded policy file link anywhere in the payload
    const policyFileUrl = findFirstFileUrl(body);

    const payload = {
      firstName,
      lastName,
      name: `${firstName} ${lastName}`.trim(),
      email,
      phone,
      policyFileUrl,

      // keep the raw body for debugging (optional)
      _rawWebhook: body
    };

    const res = await submitPolicyForReport(payload);

    return ok({
      ok: true,
      received: payload,
      backendResponse: res
    });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return badRequest({ ok: false, error: String(err) });
  }
}
