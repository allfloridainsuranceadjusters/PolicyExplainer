// backend/policyReportDataAi.js
import { fetch } from "wix-fetch";
import { getSecret } from "wix-secrets-backend";

/**
 * STRICT: returns { ok:true, reportData } only.
 * - ONLY facts from policyText.
 * - If not found: "Not found in uploaded policy."
 * - NO "typically", NO generic filler.
 * - Forces JSON output via response_format json_object.
 */
export async function generateReportData({
  policyText = "",
  firstName = "",
  policyFileName = "",
  state = "Florida",
} = {}) {
  const apiKey = await getSecret("OPENAI_API_KEY");
  if (!apiKey) return { ok: false, error: "Missing OPENAI_API_KEY in Wix Secrets Manager." };

  const trimmedText = String(policyText || "").trim();
  if (trimmedText.length < 200) {
    return { ok: false, error: "Policy text too short or missing. Could not generate report." };
  }

  const system = `
You are an insurance policy document parser.
You MUST output ONLY valid JSON (no markdown, no commentary, no backticks).
Use ONLY information explicitly present in the provided policy text.

STRICT RULES:
- Do NOT guess.
- Do NOT use "typically" or general insurance info.
- If a value is not explicitly found, return exactly: "Not found in uploaded policy."
- Exclusions/endorsements: ONLY those explicitly listed in the text.
- Money/limits/deductibles: ONLY if explicitly found.
- Examples allowed ONLY as "Illustration" and must not claim coverage beyond the text.
`.trim();

  const schema = `
Return JSON matching this EXACT structure:

{
  "docTitle": "string",
  "docSubtitle": "string",

  "insuredName": "string",
  "propertyAddress": "string",
  "policyTerm": "string",
  "effectiveTimeNote": "string",

  "atAGlance": {
    "coverages": [
      { "emoji": "string", "name": "string", "appliesTo": "string", "limit": "string" }
    ],
    "deductibles": [
      { "emoji": "string", "name": "string", "amount": "string" }
    ]
  },

  "coveragesExplained": [
    {
      "emoji": "string",
      "title": "string",
      "whatItCovers": ["string"],
      "coverageLimit": "string",
      "whatIsNotCovered": ["string"],
      "illustrationExample": "string"
    }
  ],

  "exclusions": ["string"],

  "endorsements": [
    { "emoji": "string", "name": "string", "limitOrEffect": "string" }
  ],

  "keyTakeaways": ["string"]
}

Notes:
- Keep docTitle/docSubtitle simple.
- If you cannot find any coverages/deductibles/exclusions/endorsements: return empty arrays for those.
`.trim();

  const userPrompt = `
User context:
- State: ${state}
- Requested for: ${firstName || "Not provided"}
- Source file name: ${policyFileName || "Not provided"}

TASK:
Extract policy facts and build reportData JSON.

POLICY TEXT:
${trimmedText.slice(0, 140000)}
`.trim();

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0.0,
      response_format: { type: "json_object" }, // ✅ force JSON
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${schema}\n\n${userPrompt}` },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    return { ok: false, error: `OpenAI error: ${resp.status} ${errText}` };
  }

  const json = await resp.json();
  const content = String(json.choices?.[0]?.message?.content || "").trim();

  let reportData;
  try {
    reportData = JSON.parse(content);
  } catch (e) {
    return { ok: false, error: "AI returned non-JSON output (JSON.parse failed).", raw: content.slice(0, 3000) };
  }

  if (!reportData || typeof reportData !== "object" || !reportData.atAGlance) {
    return { ok: false, error: "AI JSON missing required structure (atAGlance missing).", raw: content.slice(0, 3000) };
  }

  return { ok: true, reportData };
}
