// backend/policyReport.js — FULL FILE REPLACEMENT
// Build: CLAUDE_V2_MATCHED_SIGNATURE_20260328
//
// This file exports TWO functions:
//   1. generateReportFromPolicyTextAndUploadPdf() — called by policyExplainer.web.js
//      Receives pre-extracted policyText, returns { reportUrl, reportData }
//   2. generateReportDataFromPdfUrl() — called by events.js (automation plugin)
//      Receives policyFileUrl, downloads PDF, returns { ok, reportData, aiRaw, buildTag }
//
// Pipeline: policyText → deterministic extract → Claude AI → Render PDF → Wix Media upload
//
// Major fixes from the original:
// 1. Fixed $ regex to handle "$ 259,100" (space after dollar sign)
// 2. Fixed two-column merge: insured name / agency no longer concatenated
// 3. Added explicit "residence premises" address extraction
// 4. Added deterministic Checklist of Coverage parser for ACV/RCV
// 5. Added deterministic endorsement table parser from dec page 2
// 6. Switched AI layer from OpenAI to Claude (claude-sonnet-4-20250514)
// 7. Improved snippet windowing (larger context, smarter dedup)
// 8. AI prompt hardened: deterministic fields are locked, AI cannot overwrite them

import { fetch } from "wix-fetch";
import { mediaManager } from "wix-media-backend";
import { getSecret } from "wix-secrets-backend";
import pdfParse from "pdf-parse";

const BUILD_TAG = "CLAUDE_V2_MATCHED_SIGNATURE_20260328";
const NOT_FOUND = "Not found in uploaded policy.";
const RENDER_BASE_URL = "https://policy-pdf-renderer.onrender.com";
const MAX_SNIPPETS_CHARS = 80000;
const UPLOAD_FOLDER = "/policy-explainer-reports";

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function safeStr(v) {
  return typeof v === "string" ? v : "";
}

function normalizeSpaces(s) {
  return safeStr(s).replace(/\s+/g, " ").trim();
}

function toLines(t) {
  return safeStr(t)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Fixed: allows optional whitespace between $ and digits */
function moneyFrom(text) {
  const m = safeStr(text).match(/\$\s*[\d,]+(\.\d{2})?/);
  return m ? m[0].replace(/\$\s+/, "$") : "";
}

function percentFrom(text) {
  const m = safeStr(text).match(/(\d+(\.\d+)?)\s*%/);
  return m ? m[0] : "";
}

function looksLikeDate(s) {
  return /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(normalizeSpaces(s));
}

function extractDateRangeFromText(s) {
  const t = normalizeSpaces(s);
  const dates = t.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/g) || [];
  if (dates.length >= 2) return `${dates[0]} to ${dates[1]}`;
  return "";
}

function looksLikePolicyNumber(s) {
  const t = normalizeSpaces(s);
  if (!t) return false;
  if (/\b[A-Z]{2,}\d[\w\-]*\b/.test(t)) return true;
  if (/\b\d{6,}[\w\-]*\b/.test(t)) return true;
  return false;
}

function cleanPolicyNumber(raw) {
  let s = normalizeSpaces(raw);
  s = s.replace(/^.*?(insurance\s+company|ins\.?\s+co\.?)\s*/i, "");
  const match = s.match(/\b([A-Z]{2,}\d[\w\-]*)\b/);
  if (match) return match[1];
  const match2 = s.match(/\b(\d{6,}[\w\-]*)\b/);
  if (match2) return match2[1];
  return s;
}

function sanitizeFileName(name = "Policy-Explainer-Report") {
  return String(name)
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

// ============================================================
// DECLARATIONS PAGE EXTRACTION (DETERMINISTIC)
// ============================================================

function findDeclarationsBlock(lines) {
  const anchors = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toUpperCase();
    if (
      l.includes("POLICY NUMBER") ||
      l.includes("POLICY PERIOD") ||
      l.startsWith("INSURED")
    ) {
      anchors.push(i);
    }
  }
  if (!anchors.length) return { start: 0, end: Math.min(lines.length, 120) };

  let best = anchors[0];
  let bestScore = -1;
  for (const idx of anchors) {
    const win = lines
      .slice(Math.max(0, idx - 5), Math.min(lines.length, idx + 25))
      .join(" ")
      .toUpperCase();
    let score = 0;
    if (win.includes("POLICY NUMBER")) score += 3;
    if (win.includes("POLICY PERIOD")) score += 3;
    if (win.includes("INSURED")) score += 2;
    if (win.includes("DECLARATION")) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = idx;
    }
  }
  const start = Math.max(0, best - 10);
  const end = Math.min(lines.length, best + 80);
  return { start, end };
}

function extractPolicyNumber(blockLines) {
  const upper = blockLines.map((x) => x.toUpperCase());
  for (let i = 0; i < upper.length; i++) {
    if (!upper[i].includes("POLICY NUMBER")) continue;
    const same = normalizeSpaces(
      blockLines[i].replace(/policy\s*number/i, "").replace(/^[:\-\s]+/, "")
    );
    if (looksLikePolicyNumber(same)) return cleanPolicyNumber(same);
    for (let j = 1; j <= 10; j++) {
      const cand = normalizeSpaces(blockLines[i + j] || "");
      if (looksLikePolicyNumber(cand)) return cleanPolicyNumber(cand);
    }
    break;
  }
  return "";
}

function extractPolicyPeriod(blockLines) {
  const upper = blockLines.map((x) => x.toUpperCase());
  for (let i = 0; i < upper.length; i++) {
    if (!upper[i].includes("POLICY PERIOD") && !upper[i].includes("POLICY TERM")) continue;
    const win = normalizeSpaces(blockLines.slice(i, Math.min(blockLines.length, i + 12)).join(" "));
    const range = extractDateRangeFromText(win);
    if (range) return range;
  }
  for (const line of blockLines) {
    if (!/policy/i.test(line)) continue;
    const range = extractDateRangeFromText(line);
    if (range) return range;
  }
  for (const line of blockLines) {
    const range = extractDateRangeFromText(line);
    if (range) return range;
  }
  return "";
}

/**
 * Fixed: Handles two-column layout where INSURED and AGENCY are on the same line.
 * Also uses the explicit "residence premises" address line.
 */
function extractInsuredAndAddress(blockLines) {
  const upper = blockLines.map((x) => x.toUpperCase());
  let insuredName = "";
  let propertyAddress = "";

  // Strategy 1: "residence premises ... located at the address listed below"
  for (let i = 0; i < blockLines.length; i++) {
    if (
      /residence\s+premises.*located/i.test(blockLines[i]) ||
      /property.*address/i.test(blockLines[i]) ||
      /insured\s+location/i.test(blockLines[i])
    ) {
      for (let j = 1; j <= 5; j++) {
        const cand = normalizeSpaces(blockLines[i + j] || "");
        if (/\b\d{1,6}\s+/.test(cand) && cand.length > 10) {
          propertyAddress = cand;
          break;
        }
      }
      if (propertyAddress) break;
    }
  }

  // Strategy 2: INSURED label — handle two-column merge
  for (let i = 0; i < upper.length; i++) {
    if (!upper[i].startsWith("INSURED")) continue;
    const isTwoColumn = /AGENCY/i.test(blockLines[i]);
    const names = [];
    for (let j = 1; j <= 10; j++) {
      const raw = normalizeSpaces(blockLines[i + j] || "");
      if (!raw) continue;
      if (/^(phone|the\s+residence|coverage\s+is|coverages|section|deductible)/i.test(raw)) break;
      if (/^\d{1,6}\s+/.test(raw) && /\b[A-Z]{2}\s+\d{5}/.test(raw)) break;

      if (isTwoColumn) {
        let leftPart = raw;
        const agencyPatterns = [
          /\s+(DESIGN\s+INSURANCE)/i,
          /\s+(INSURANCE\s+(AGENCY|GROUP|INC|LLC|CORP))/i,
          /\s+(\d{3,5}\s+[A-Z].*\b(RD|ST|AVE|BLVD|DR|WAY|CT|LN)\b)/i,
          /\s+(BOCA\s+RATON|ORLANDO|TAMPA|JACKSONVILLE|FORT\s+)/i,
          /\s+(Agency\s+ID)/i,
        ];
        for (const pat of agencyPatterns) {
          const m = raw.match(pat);
          if (m && m.index > 5) {
            leftPart = raw.substring(0, m.index).trim();
            break;
          }
        }
        if (leftPart && leftPart.length >= 3 && /[A-Z]/.test(leftPart) && !/^\d{1,6}\s+/.test(leftPart)) {
          const bad = ["agency", "producer", "page", "declarations", "customer service", "www.", "effective:", "date issued"];
          if (!bad.some((b) => leftPart.toLowerCase().includes(b))) {
            names.push(leftPart);
          }
        }
      } else {
        if (raw.length >= 3 && /[A-Z]/.test(raw) && !/^\d{1,6}\s+/.test(raw)) {
          const bad = ["named insured", "policy period", "policy number", "agency", "producer", "page", "declarations", "customer service", "www.", "effective:", "date issued"];
          if (!bad.some((b) => raw.toLowerCase().includes(b))) {
            names.push(raw);
          }
        }
      }
      if (names.length >= 2) break;
    }
    if (names.length > 0) insuredName = names.join("\n");
    break;
  }

  // Strategy 3: Fallback address
  if (!propertyAddress) {
    for (const line of blockLines) {
      const t = normalizeSpaces(line);
      if (/\b\d{1,6}\s+\w+.*,\s*[A-Z]{2}\s+\d{5}\b/.test(t) && t.length > 15) {
        if (!/BOCA\s+RATON|FLORENCE|LEHIGH/i.test(t)) {
          propertyAddress = t;
          break;
        }
      }
    }
  }

  return { insuredName, propertyAddress };
}

function extractCoverageLimits(lines) {
  const coverageDefs = [
    { name: "Coverage A – Dwelling", pattern: /^A\.\s*(DWELLING)/i, emoji: "🏡", appliesTo: "Your home and attached structures" },
    { name: "Coverage B – Other Structures", pattern: /^B\.\s*(OTHER\s+STRUCTURES)/i, emoji: "🏠", appliesTo: "Detached structures (shed, fence, detached garage)" },
    { name: "Coverage C – Personal Property", pattern: /^C\.\s*(PERSONAL\s+PROPERTY)/i, emoji: "📦", appliesTo: "Your belongings (furniture, clothing, electronics)" },
    { name: "Coverage D – Loss of Use", pattern: /^D\.\s*(LOSS\s+OF\s+USE)/i, emoji: "🏨", appliesTo: "Additional living expenses if home is uninhabitable" },
    { name: "Coverage E – Personal Liability", pattern: /^E\.\s*(PERSONAL\s+LIABILITY)/i, emoji: "⚖️", appliesTo: "Lawsuits for bodily injury or property damage you cause" },
    { name: "Coverage F – Medical Payments", pattern: /^F\.\s*(MEDICAL\s+PAYMENTS)/i, emoji: "🩺", appliesTo: "Medical bills for guests injured on your property" },
  ];

  const coverages = [];
  for (const def of coverageDefs) {
    let limit = NOT_FOUND;
    for (const line of lines) {
      if (def.pattern.test(normalizeSpaces(line))) {
        const money = moneyFrom(line);
        if (money) { limit = money; break; }
      }
    }
    if (limit === NOT_FOUND) {
      const broader = new RegExp(
        def.name.replace(/Coverage [A-F] – /i, "").replace(/\s+/g, "\\s+"), "i"
      );
      for (let i = 0; i < lines.length; i++) {
        if (!broader.test(lines[i])) continue;
        const money = moneyFrom(lines[i]);
        if (money) { limit = money; break; }
        for (let j = 1; j <= 4; j++) {
          if (i + j >= lines.length) break;
          const m = moneyFrom(lines[i + j]);
          if (m) { limit = m; break; }
        }
        if (limit !== NOT_FOUND) break;
      }
    }
    coverages.push({ name: def.name, emoji: def.emoji, appliesTo: def.appliesTo, limit, valuation: NOT_FOUND });
  }
  return coverages;
}

function extractDeductibles(lines) {
  const dedLines = lines.filter((l) => /deductible/i.test(l));
  const allOtherLine = dedLines.find((l) => /all\s+other\s+perils/i.test(l)) || dedLines.find((l) => /all\s+other/i.test(l)) || "";
  const hurricaneLine = dedLines.find((l) => /hurricane\s+deductible/i.test(l)) || dedLines.find((l) => /hurricane/i.test(l)) || dedLines.find((l) => /windstorm/i.test(l)) || "";

  const allOtherAmount = moneyFrom(allOtherLine) || NOT_FOUND;
  let hurricaneAmount = moneyFrom(hurricaneLine);
  if (hurricaneAmount && /\d+\s*%/.test(hurricaneLine) && !hurricaneAmount.includes("%")) {
    const pct = percentFrom(hurricaneLine);
    if (pct) hurricaneAmount = `${pct} of Coverage A = ${hurricaneAmount}`;
  }
  if (!hurricaneAmount) {
    const pct = percentFrom(hurricaneLine);
    hurricaneAmount = pct || NOT_FOUND;
  }

  return [
    { name: "All Other Perils", emoji: "🧮", amount: allOtherAmount },
    { name: "Hurricane / Windstorm", emoji: "🌀", amount: hurricaneAmount || NOT_FOUND },
  ];
}

/**
 * Parse Checklist of Coverage page for ACV/RCV.
 * Florida OIR form B1-1670: "Loss Settlement Basis: Replacement Cost"
 */
function extractValuationFromChecklist(lines) {
  const valuationMap = {};
  const patterns = [
    { search: /Dwelling\s+Structure\s+Coverage/i, key: "Coverage A – Dwelling" },
    { search: /Other\s+Structures\s+Coverage/i, key: "Coverage B – Other Structures" },
    { search: /Personal\s+Property\s+Coverage/i, key: "Coverage C – Personal Property" },
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const cp of patterns) {
      if (!cp.search.test(lines[i])) continue;
      const window = lines.slice(i, Math.min(lines.length, i + 5)).join(" ");
      if (/replacement\s+cost/i.test(window)) valuationMap[cp.key] = "RCV";
      else if (/actual\s+cash\s+value/i.test(window)) valuationMap[cp.key] = "ACV";
    }
  }
  return valuationMap;
}

/**
 * Parse endorsements table from dec page.
 * Handles lines like:
 *   "FP HO LWD 03 23 LIMITED WATER DAMAGE COVERAGE $ 10,000 $ -2,091.67"
 *   "LAW AND ORDINANCE 25% Included"
 *   "SINKHOLE LOSS COVERAGE Excluded"
 */
function extractEndorsementsFromDecPage(lines) {
  const endorsements = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = normalizeSpaces(lines[i]);
    const upper = line.toUpperCase();
    if (upper === "ENDORSEMENTS" || /^endorsements$/i.test(line)) { inSection = true; continue; }
    if (inSection && (upper.startsWith("FEES AND ASSESSMENTS") || upper.startsWith("FPI HO DEC") || /^page\s+\d+\s+of/i.test(line))) break;
    if (!inSection) continue;
    if (/^form\s*#/i.test(line) || line.length < 10) continue;

    // Step 1: Strip form number prefix (e.g., "FP HO LWD 03 23" or "FP 04 95 02 14")
    let description = line;
    const formMatch = line.match(/^(?:[A-Z]{2,3}\s+)+(?:[A-Z\d]+\s+)*\d{2}\s+\d{2}\s+/i);
    if (formMatch) description = line.substring(formMatch[0].length).trim();

    // Step 2: Detect if excluded
    const isExcluded = /\bexcluded\b/i.test(description);

    // Step 3: Extract the coverage limit (first dollar amount that looks like a limit, not a premium)
    // Limits are positive: $10,000, $5,000, $1,000
    // Premiums are often negative or at end: $-2,091.67, $1,974.51
    // Strategy: grab all dollar amounts, take the first one that doesn't start with -
    const allMoney = description.match(/\$\s*-?[\d,]+(\.\d{2})?/g) || [];
    let limit = "";
    for (const m of allMoney) {
      const normalized = m.replace(/\$\s+/, "$");
      if (!normalized.startsWith("$-")) {
        // Check if this looks like a round limit (no cents, or .00)
        const val = parseFloat(normalized.replace(/[$,]/g, ""));
        if (val >= 500 && (val % 1 === 0 || /\.00$/.test(normalized))) {
          limit = normalized;
          break;
        }
      }
    }
    // If no round limit found, try percentage
    if (!limit) {
      const pct = percentFrom(description);
      if (pct) limit = pct;
    }

    // Step 4: Clean the name — remove ALL dollar amounts, percentages, and status words
    let cleanDesc = description
      .replace(/\$\s*-?[\d,]+(\.\d{2})?/g, "")  // remove all dollar amounts
      .replace(/\d+(\.\d+)?\s*%/g, "")            // remove percentages
      .replace(/\b(Included|Excluded)\b/gi, "")   // remove status words
      .replace(/\s{2,}/g, " ")
      .trim();

    if (cleanDesc.length < 5) continue;

    endorsements.push({
      name: cleanDesc,
      limitOrEffect: isExcluded ? "Excluded" : (limit || NOT_FOUND),
      example: "",
    });
  }
  return endorsements;
}

// ============================================================
// MASTER DETERMINISTIC EXTRACTION
// ============================================================

function deterministicExtract(fullText) {
  const lines = toLines(fullText);
  const { start, end } = findDeclarationsBlock(lines);
  const blockLines = lines.slice(start, end);

  const policyNumber = extractPolicyNumber(blockLines);
  const policyPeriod = extractPolicyPeriod(blockLines);
  const { insuredName, propertyAddress } = extractInsuredAndAddress(blockLines);
  const coverages = extractCoverageLimits(lines);
  const deductibles = extractDeductibles(lines);
  const valuationMap = extractValuationFromChecklist(lines);
  const endorsements = extractEndorsementsFromDecPage(lines);

  for (const c of coverages) {
    if (valuationMap[c.name]) {
      c.valuation = valuationMap[c.name];
    } else if (/Coverage [DEF]/.test(c.name)) {
      // ACV/RCV does not apply to Loss of Use, Liability, or Medical Payments
      c.valuation = "N/A";
    }
  }

  return {
    insuredName: insuredName || NOT_FOUND,
    propertyAddress: propertyAddress || NOT_FOUND,
    policyNumber: policyNumber || NOT_FOUND,
    policyTerm: policyPeriod || NOT_FOUND,
    atAGlance: { coverages, deductibles },
    endorsements,
  };
}

// ============================================================
// SNIPPET GENERATION
// ============================================================

function collectSnippets(fullText, patterns = []) {
  const t = safeStr(fullText);
  const lower = t.toLowerCase();
  const hits = [];

  for (const p of patterns) {
    const needle = p.toLowerCase();
    let idx = 0;
    let count = 0;
    while (idx >= 0 && count < 5) {
      idx = lower.indexOf(needle, idx);
      if (idx === -1) break;
      const start = Math.max(0, idx - 1000);
      const end = Math.min(t.length, idx + 3000);
      hits.push({ key: p, window: t.slice(start, end).trim() });
      idx = idx + needle.length;
      count++;
    }
    if (hits.length > 60) break;
  }

  const seen = new Set();
  const unique = [];
  for (const h of hits) {
    const k = h.window.slice(0, 300);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(h);
  }

  let out = "";
  for (const h of unique) {
    const block = `\n\n--- SNIPPET [${h.key}] ---\n${h.window}`;
    if (out.length + block.length > MAX_SNIPPETS_CHARS) break;
    out += block;
  }
  return out.trim();
}

// ============================================================
// AI LAYER — CLAUDE API
// ============================================================

async function callClaudeJson({ system, user, model = "claude-sonnet-4-20250514", temperature = 0.2 }) {
  const apiKey = await getSecret("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY in Secrets Manager.");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      temperature,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  const rawEnvelope = await resp.json().catch(() => null);
  if (!resp.ok || !rawEnvelope) {
    const fallback = rawEnvelope ? JSON.stringify(rawEnvelope) : "(no json)";
    throw new Error(`Claude API error: ${resp.status} ${fallback}`);
  }

  const content = safeStr(rawEnvelope?.content?.[0]?.text);
  if (!content) throw new Error("Claude returned no message content.");

  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[1].trim()); }
      catch (e2) { throw new Error(`Claude JSON parse failed. First 300 chars: ${content.slice(0, 300)}`); }
    } else {
      // Try to find JSON object in the response
      const braceMatch = content.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        try { parsed = JSON.parse(braceMatch[0]); }
        catch (e3) { throw new Error(`Claude JSON parse failed. First 300 chars: ${content.slice(0, 300)}`); }
      } else {
        throw new Error(`Claude returned no JSON. First 300 chars: ${content.slice(0, 300)}`);
      }
    }
  }

  return { parsed, aiRaw: content };
}

async function callClaudeForReportData({ snippets, baseReportData, firstName, state }) {
  const system = `You are an insurance policy document parser for a Florida public adjusting firm.

STRICT RULES:
1. Use ONLY the provided snippets from the uploaded policy. Never guess or infer.
2. If a fact is not explicitly stated in the snippets, output exactly: "${NOT_FOUND}"
3. Never use "typically" or "usually" language — only facts from this specific policy.
4. Output valid JSON only — no markdown, no explanation, no code fences.
5. DO NOT modify the locked fields (insuredName, propertyAddress, policyNumber, policyTerm, atAGlance).
6. For coveragesExplained: ALWAYS include all 6 standard HO-3 coverages (A through F) FIRST,
   then add any endorsement-based coverages after.
7. For exclusions: extract only what the policy explicitly excludes.
8. Examples should be generic illustrations, never specific dollar amounts unless stated in the policy.`;

  const user = `Return a single JSON object. No markdown. No code fences. Just the raw JSON.

{
  "coveragesExplained": [
    {
      "title": "Coverage A – Dwelling",
      "whatItCovers": ["...from snippets only..."],
      "coverageLimit": "...from snippets or ${NOT_FOUND}...",
      "whatIsNotCovered": ["...from snippets only..."],
      "illustrationExample": "One generic sentence example."
    }
  ],
  "exclusions": [
    { "text": "...from policy text...", "example": "One sentence illustration." }
  ],
  "endorsements": [
    { "name": "...endorsement name...", "example": "One sentence illustration of what this endorsement means for the homeowner." }
  ],
  "keyTakeaways": ["Fact-based bullet from the policy...", "..."]
}

IMPORTANT:
- coveragesExplained MUST include A through F in order, using the HO-3 policy text.
- keyTakeaways should be 4-6 fact-based bullets highlighting the most important things.
- For endorsements: use the pre-extracted endorsement names below. For each one, write a short
  plain-English example of what it means for the homeowner. Match by name.
  Example: "LIMITED WATER DAMAGE COVERAGE" → "Water damage from plumbing leaks is capped at $10,000 per occurrence under this endorsement."

Context:
- State: ${state}
- First name: ${firstName}

Pre-extracted data (LOCKED — do not modify):
${JSON.stringify({
  insuredName: baseReportData.insuredName,
  propertyAddress: baseReportData.propertyAddress,
  policyNumber: baseReportData.policyNumber,
  policyTerm: baseReportData.policyTerm,
  coverageLimits: baseReportData.atAGlance.coverages.map(c => ({ name: c.name, limit: c.limit, valuation: c.valuation })),
  deductibles: baseReportData.atAGlance.deductibles,
  endorsements: baseReportData.endorsements,
}, null, 2)}

Policy Snippets:
${snippets}`;

  const { parsed, aiRaw } = await callClaudeJson({ system, user, temperature: 0.15 });
  return { parsed, aiRaw };
}

// ============================================================
// MERGE AI + DETERMINISTIC
// ============================================================

function mergeAiWithDeterministic(baseReportData, aiOutput) {
  const merged = {
    docTitle: "Insurance Policy Explainer",
    docSubtitle: "Plain-English Guide",
    insuredName: baseReportData.insuredName,
    propertyAddress: baseReportData.propertyAddress,
    policyNumber: baseReportData.policyNumber,
    policyTerm: baseReportData.policyTerm,
    atAGlance: baseReportData.atAGlance,
    coveragesExplained: Array.isArray(aiOutput?.coveragesExplained) ? aiOutput.coveragesExplained : [],
    exclusions: Array.isArray(aiOutput?.exclusions) ? aiOutput.exclusions : [],
    endorsements: baseReportData.endorsements,
    keyTakeaways: Array.isArray(aiOutput?.keyTakeaways) ? aiOutput.keyTakeaways : [],
  };

  // Merge AI examples into deterministic endorsements
  if (Array.isArray(aiOutput?.endorsements)) {
    for (const aiEnd of aiOutput.endorsements) {
      if (!aiEnd?.name || !aiEnd?.example) continue;
      const aiName = aiEnd.name.toLowerCase();
      // Try to find a matching deterministic endorsement
      const match = merged.endorsements.find((e) => {
        if (!e.name) return false;
        const eName = e.name.toLowerCase();
        // Check if key words overlap (at least 2 significant words match)
        const aiWords = aiName.split(/\s+/).filter(w => w.length > 3);
        const eWords = eName.split(/\s+/).filter(w => w.length > 3);
        const overlap = aiWords.filter(w => eWords.some(ew => ew.includes(w) || w.includes(ew)));
        return overlap.length >= 2 || eName.includes(aiName.slice(0, 20)) || aiName.includes(eName.slice(0, 20));
      });
      if (match) match.example = aiEnd.example;
    }
  }

  // Ensure all valuations have a value
  const covers = merged.atAGlance?.coverages;
  if (Array.isArray(covers)) {
    for (const c of covers) {
      if (!safeStr(c.valuation).trim()) c.valuation = NOT_FOUND;
    }
  }

  return merged;
}

// ============================================================
// RENDER PDF + UPLOAD TO WIX MEDIA
// ============================================================

async function renderAndUploadPdf({ reportData, meta, branding, submissionId }) {
  const renderUrl = `${RENDER_BASE_URL}/render`;
  const resp = await fetch(renderUrl, {
    method: "post",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      reportData,
      meta: {
        name: safeStr(meta?.name),
        email: safeStr(meta?.email),
      },
      branding: {
        logoUrl: safeStr(branding?.logoUrl),
        company: branding?.company || {},
      },
    }),
  });

  if (!resp.ok) {
    let errText = "";
    try { errText = await resp.text(); } catch (_) {}
    throw new Error(`Render PDF service error (${resp.status}): ${errText}`);
  }

  const pdfBuf = await resp.buffer();

  const safeId = safeStr(submissionId).trim() || `${Date.now()}`;
  const baseName = sanitizeFileName(`Policy-Explainer-Report-${safeId}`);
  const fileName = `${baseName}.pdf`;

  let uploadRes;
  try {
    uploadRes = await mediaManager.upload(UPLOAD_FOLDER, pdfBuf, fileName, {
      mediaOptions: { mimeType: "application/pdf", mediaType: "document" },
      metadataOptions: { isPrivate: false },
    });
  } catch (_) {
    uploadRes = await mediaManager.upload(UPLOAD_FOLDER, pdfBuf, fileName);
  }

  const fileUrl = uploadRes?.fileUrl || uploadRes?.url || uploadRes?.mediaUrl || "";
  const downloadUrl = uploadRes?.downloadUrl || fileUrl;

  return { fileName, fileUrl, downloadUrl };
}

// ============================================================
// MAIN EXPORT — matches policyExplainer.web.js contract
// ============================================================

/**
 * Called by policyExplainer.web.js as:
 *   generateReportFromPolicyTextAndUploadPdf({
 *     submissionId, policyText, name, email, logoUrl, company
 *   })
 *
 * Returns: { reportUrl, reportData, error? }
 */
export async function generateReportFromPolicyTextAndUploadPdf({
  submissionId = "",
  policyText = "",
  name = "",
  email = "",
  logoUrl = "",
  company = {},
} = {}) {
  try {
    if (!policyText || !policyText.trim()) {
      throw new Error("Missing policyText — nothing to analyze.");
    }

    console.log(`[${BUILD_TAG}] Starting report generation for submission: ${submissionId}`);

    // Step 1: Deterministic extraction from pre-extracted text
    const base = deterministicExtract(policyText);
    console.log(`[${BUILD_TAG}] Deterministic extraction complete. Policy#: ${base.policyNumber}, Insured: ${base.insuredName.slice(0, 40)}`);

    const baseReportData = {
      insuredName: base.insuredName,
      propertyAddress: base.propertyAddress,
      policyNumber: base.policyNumber,
      policyTerm: base.policyTerm,
      atAGlance: base.atAGlance,
      endorsements: base.endorsements,
    };

    // Step 2: Generate snippets for AI
    const patterns = [
      "coverage a", "coverage b", "coverage c", "coverage d", "coverage e", "coverage f",
      "dwelling", "other structures", "personal property", "loss of use",
      "personal liability", "medical payments",
      "deductible", "hurricane deductible",
      "endorsement", "exclusions",
      "replacement cost", "actual cash value", "loss settlement",
      "we do not insure", "we do not cover", "not covered",
      "perils insured against", "additional coverages",
      "debris removal", "emergency mitigation", "ordinance or law",
      "fungi", "mold", "water damage", "flood",
      "sinkhole", "catastrophic ground cover",
      "vacant", "unoccupied",
      "water back-up", "sump",
      "limited water damage",
      "matching of undamaged",
      "limitations on roof",
      "communicable disease",
      "home sharing",
    ];

    const snippets = collectSnippets(policyText, patterns);
    console.log(`[${BUILD_TAG}] Snippets generated: ${snippets.length} chars`);

    // Step 3: Call Claude for AI-generated fields
    const aiResult = await callClaudeForReportData({
      snippets,
      baseReportData,
      firstName: name,
      state: "Florida",
    });
    console.log(`[${BUILD_TAG}] Claude AI response received.`);

    // Step 4: Merge — deterministic fields win
    const reportData = mergeAiWithDeterministic(baseReportData, aiResult.parsed);

    // Step 5: Render PDF and upload to Wix Media
    const pdfResult = await renderAndUploadPdf({
      reportData,
      meta: { name, email },
      branding: {
        logoUrl: logoUrl || "https://static.wixstatic.com/media/c5554f_804cd8f5df3b4f8dadc4b7c8a028623d~mv2.png",
        company: company || {},
      },
      submissionId,
    });
    console.log(`[${BUILD_TAG}] PDF uploaded: ${pdfResult.downloadUrl}`);

    return {
      reportUrl: pdfResult.downloadUrl || pdfResult.fileUrl,
      reportData,
      buildTag: BUILD_TAG,
    };
  } catch (err) {
    console.error(`[${BUILD_TAG}] ERROR:`, err?.message || err);
    return {
      reportUrl: "",
      reportData: null,
      error: String(err?.message || err),
    };
  }
}

// ============================================================
// COMPATIBILITY EXPORT — used by events.js (automation plugin)

async function downloadAndExtractText(pdfUrl) {
  const res = await fetch(pdfUrl);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`PDF download failed (${res.status}): ${body}`);
  }
  const buf = await res.buffer();
  const data = await pdfParse(buf);
  return safeStr(data?.text).trim();
}

function getTextQualityStats(text) {
  const t = safeStr(text);
  const len = t.length;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const newlines = (t.match(/\n/g) || []).length;
  const ratio = len > 0 ? letters / len : 0;
  const quality = ratio >= 0.08 && letters >= 2500 ? "ok" : "low";
  return { quality, len, letters, newlines, ratio };
}

async function tryOcrDeclarationsText(pdfUrl) {
  try {
    const resp = await fetch(`${RENDER_BASE_URL}/ocr-declarations`, {
      method: "post",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdfUrl }),
    });
    const j = await resp.json().catch(() => null);
    if (!resp.ok || !j?.ok) return "";
    return safeStr(j?.text).trim();
  } catch (_) {
    return "";
  }
}

export async function generateReportDataFromPdfUrl({
  policyFileUrl = "",
  firstName = "",
  policyFileName = "",
  state = "Florida",
} = {}) {
  if (!policyFileUrl) throw new Error("Missing policyFileUrl.");

  console.log(`[${BUILD_TAG}] generateReportDataFromPdfUrl called for: ${policyFileName}`);

  // Step 1: Download and extract text
  let fullText = await downloadAndExtractText(policyFileUrl);
  const stats = getTextQualityStats(fullText);
  console.log(`[${BUILD_TAG}] Text quality: ${stats.quality}, letters: ${stats.letters}, ratio: ${stats.ratio.toFixed(3)}`);

  // Step 2: OCR fallback if text quality is poor
  if (stats.quality === "low") {
    const ocrText = await tryOcrDeclarationsText(policyFileUrl);
    const ocrStats = getTextQualityStats(ocrText);
    const ocrUpper = ocrText.toUpperCase();
    const hasAnchors =
      ocrUpper.includes("POLICY NUMBER") ||
      ocrUpper.includes("POLICY PERIOD") ||
      ocrUpper.includes("INSURED") ||
      ocrUpper.includes("DECLARATION");

    if (ocrText && ocrStats.letters >= 600 && (hasAnchors || ocrStats.ratio >= stats.ratio)) {
      fullText = `${ocrText}\n\n--- ORIGINAL PARSED TEXT ---\n${fullText}`.trim();
      console.log(`[${BUILD_TAG}] OCR fallback used. Combined text length: ${fullText.length}`);
    }
  }

  // Step 3: Deterministic extraction
  const base = deterministicExtract(fullText);
  console.log(`[${BUILD_TAG}] Deterministic: Policy#=${base.policyNumber}, Insured=${base.insuredName.slice(0, 40)}`);

  const baseReportData = {
    insuredName: base.insuredName,
    propertyAddress: base.propertyAddress,
    policyNumber: base.policyNumber,
    policyTerm: base.policyTerm,
    atAGlance: base.atAGlance,
    endorsements: base.endorsements,
  };

  // Step 4: Snippets + Claude AI
  const patterns = [
    "coverage a", "coverage b", "coverage c", "coverage d", "coverage e", "coverage f",
    "dwelling", "other structures", "personal property", "loss of use",
    "personal liability", "medical payments",
    "deductible", "hurricane deductible",
    "endorsement", "exclusions",
    "replacement cost", "actual cash value", "loss settlement",
    "we do not insure", "we do not cover", "not covered",
    "perils insured against", "additional coverages",
    "debris removal", "emergency mitigation", "ordinance or law",
    "fungi", "mold", "water damage", "flood",
    "sinkhole", "catastrophic ground cover",
    "vacant", "unoccupied",
    "water back-up", "sump",
    "limited water damage", "matching of undamaged",
    "limitations on roof", "communicable disease", "home sharing",
  ];

  const snippets = collectSnippets(fullText, patterns);
  console.log(`[${BUILD_TAG}] Snippets: ${snippets.length} chars`);

  const aiResult = await callClaudeForReportData({
    snippets,
    baseReportData,
    firstName,
    state,
  });
  console.log(`[${BUILD_TAG}] Claude AI complete.`);

  // Step 5: Merge
  const reportData = mergeAiWithDeterministic(baseReportData, aiResult.parsed);

  return {
    ok: true,
    reportData,
    aiRaw: aiResult.aiRaw,
    buildTag: BUILD_TAG,
    textQuality: stats,
  };
}
