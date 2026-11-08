"use strict";
// Server-side Groq integration. The API key stays on the server and is never sent to the browser.
// The AI only EXPLAINS and SYNTHESIZES numbers produced by the risk model. It does not create or change scores.

const DRIVER_NAMES = {
  temp: "temperature",
  hum: "dry air (low humidity)",
  wind: "wind speed",
  ndvi: "dry vegetation (low NDVI)",
  hist: "fire history",
};

const SYSTEM_PROMPT_EXPLAIN = [
  "You are the explanation layer of IGNIS AI, a forest-fire risk early-warning prototype.",
  "A machine-learning model has ALREADY produced the risk score. Your only job is to explain it in plain language for a fire-station officer.",
  "Rules:",
  "- Use ONLY the numbers in the JSON you are given. Never change, recompute or question the score. Never invent data, accuracy figures, dates, fire history or places.",
  "- Do not say the prediction is validated or certain. This is a prototype running on demonstration data.",
  "- The explanation must be 2 or 3 short sentences. Give at most 3 factors and at most 3 preventive actions.",
  "- Actions must be practical: patrols, staging tankers and crews, community advisories, re-checking the forecast.",
  "- Plain text only. No markdown.",
  'Respond with one JSON object: {"explanation": string, "factors": string[], "actions": string[]}',
].join("\n");

const SYSTEM_PROMPT_BRIEFING = [
  "You are the Tactical Briefing Officer of IGNIS AI, an early-warning wildfire risk platform prototype.",
  "Your task is to generate an Operational Fire Danger Briefing for station commanders and field supervisors.",
  "Rules:",
  "- Base your briefing EXCLUSIVELY on the provided 7-day forecast data, active zone alerts, weather drivers, and nearest villages.",
  "- Never contradict the scores. Never invent fake fires, historical incidents, or false certifications.",
  "- If information is unavailable or outside the provided forecast scope, explicitly state that.",
  "- Clearly note that dispatches and alerts on this platform are simulated prototype actions.",
  "- Provide a crisp, professional military/incident command style briefing.",
  "- Outline: Threat assessment, critical escalation windows, weather hazards (temperature, humidity drop, wind), resource staging, and community advisories.",
  "- Respond in valid JSON with this exact schema:",
  '{"title": string, "threatLevel": "high"|"moderate"|"low", "summary": string, "keyRisks": string[], "stagedRecommendations": string[], "briefingText": string}',
].join("\n");

const SYSTEM_PROMPT_CHAT = [
  "You are the IGNIS AI Commander Assistant, an AI advisor for fire-station officers and wildland incident commanders.",
  "You assist the officer by answering questions about the current 7-day wildfire risk forecast, active zone alerts, weather drivers (temperature, humidity, wind, NDVI), and resource positioning.",
  "Rules:",
  "- Rely strictly on the provided context (current day, selected zone, alerts, stations, and weather conditions).",
  "- Never invent non-existent zones, numbers, or unverified fire detections.",
  "- If the user asks about data or zones not provided in the context, explicitly state that the information is unavailable in the current 7-day forecast model.",
  "- Note that dispatches and alerts on this platform are demonstration simulations, not live deployments.",
  "- Keep answers concise, factual, and tactical (under 160 words).",
  "- Focus on firefighter safety, resource staging, containment difficulty, and community warnings.",
  "- Plain text with bullet points if listing items. No verbose fluff.",
  'Respond with valid JSON: {"reply": string, "suggestedAction": string}',
].join("\n");

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function num(v, min, max, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw httpError(400, "Invalid " + name + ".");
  return n;
}

function cleanStr(s, maxLen) {
  return String(s || "")
    .replace(/[^\p{L}\p{N} ,.\-?_!():/]/gu, "")
    .slice(0, maxLen || 100);
}

// Strictly validates explanation payload
function validate(body) {
  if (!body || typeof body !== "object") throw httpError(400, "Body must be JSON.");
  const zoneId = String(body.zoneId || "");
  if (!/^[A-Z][0-9]{1,2}$/.test(zoneId)) throw httpError(400, "Invalid zoneId.");
  const day = num(body.day, 1, 7, "day");
  const score = num(body.score, 0, 100, "score");
  if (!Array.isArray(body.drivers) || body.drivers.length < 1 || body.drivers.length > 5) throw httpError(400, "Invalid drivers.");
  const drivers = body.drivers.map((d) => {
    if (!d || !DRIVER_NAMES[d.key]) throw httpError(400, "Unknown driver.");
    return { factor: DRIVER_NAMES[d.key], sharePercent: num(d.pct, 0, 100, "driver percentage") };
  });
  const c = body.conditions || {};
  const conditions = {
    temperatureC: num(c.tempC, -30, 60, "tempC"),
    humidityPercent: num(c.humidityPct, 0, 100, "humidityPct"),
    windKmh: num(c.windKmh, 0, 200, "windKmh"),
    ndvi: num(c.ndvi, -1, 1, "ndvi"),
    fireHistoryIndex: num(c.fireHistory, 0, 1, "fireHistory"),
  };
  return {
    zoneId,
    daysAhead: day,
    riskScore: score,
    severity: score >= 65 ? "high" : score >= 40 ? "medium" : "low",
    topDrivers: drivers,
    conditions,
    nearestVillage: cleanStr(body.nearestVillage, 40),
    nearestStation: cleanStr(body.station, 40),
  };
}

function cleanList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === "string")
    .map((x) => x.trim().slice(0, maxLen || 180))
    .filter(Boolean)
    .slice(0, maxItems || 3);
}

function parseModelOutput(text) {
  let obj = null;
  try { obj = JSON.parse(text); } catch (e) {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (e2) { obj = null; } }
  }
  if (obj && typeof obj === "object") {
    return {
      explanation: String(obj.explanation || "").trim().slice(0, 700),
      factors: cleanList(obj.factors, 3, 180),
      actions: cleanList(obj.actions, 3, 180),
    };
  }
  return { explanation: String(text).trim().slice(0, 700), factors: [], actions: [] };
}

async function callGroqDirect(systemPrompt, userPayload, useJsonMode, maxTokens) {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    throw httpError(503, "Groq AI features are disabled. Add GROQ_API_KEY to your .env file and restart the server.");
  }
  const base = (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
  const body = {
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    temperature: 0.2,
    max_tokens: maxTokens || 450,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: typeof userPayload === "string" ? userPayload : JSON.stringify(userPayload) },
    ],
  };
  if (useJsonMode) body.response_format = { type: "json_object" };

  let res;
  try {
    res = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(22000),
    });
    if (res.status === 400 && useJsonMode) {
      delete body.response_format;
      res = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(22000),
      });
    }
  } catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw httpError(504, "Groq took too long to answer. Try again.");
    }
    throw httpError(502, "Could not reach Groq. Check your internet connection.");
  }

  if (res.status === 401 || res.status === 403) throw httpError(502, "Groq rejected the API key. Check GROQ_API_KEY in .env.");
  if (res.status === 404) throw httpError(502, "Groq does not recognize model " + (process.env.GROQ_MODEL || "") + ". Check GROQ_MODEL.");
  if (res.status === 429) throw httpError(429, "Groq rate limit reached. Wait a moment and try again.");
  if (!res.ok) throw httpError(502, "Groq request failed (status " + res.status + ").");

  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw httpError(502, "Groq returned an empty response.");
  return text;
}

// 1. Single zone explain
async function explain(rawBody) {
  const payload = validate(rawBody);
  const rawText = await callGroqDirect(SYSTEM_PROMPT_EXPLAIN, payload, true, 450);
  return parseModelOutput(rawText);
}

// 2. Operational briefing generator
async function briefing(rawBody) {
  if (!rawBody || typeof rawBody !== "object") throw httpError(400, "Briefing payload must be JSON.");
  const day = num(rawBody.day, 1, 7, "day");
  const alerts = Array.isArray(rawBody.alerts) ? rawBody.alerts.slice(0, 15) : [];
  const topRisks = Array.isArray(rawBody.topRisks) ? rawBody.topRisks.slice(0, 10) : [];

  const payload = {
    forecastDay: day,
    activeAlertsCount: alerts.length,
    alerts: alerts.map((a) => ({ zoneId: cleanStr(a.id || a.zoneId, 6), day: a.day, score: a.score })),
    criticalZones: topRisks.map((z) => ({
      zoneId: cleanStr(z.id, 6),
      score: z.score,
      tempC: z.temp,
      humidityPct: z.hum,
      windKmh: z.wind,
      ndvi: z.ndvi,
    })),
    nearestVillages: Array.isArray(rawBody.villages)
      ? rawBody.villages.map((v) => cleanStr(typeof v === "string" ? v : v && v.n, 40)).filter(Boolean).slice(0, 8)
      : [],
    stations: Array.isArray(rawBody.stations)
      ? rawBody.stations.map((s) => cleanStr(typeof s === "string" ? s : s && s.n, 40)).filter(Boolean).slice(0, 5)
      : [],
  };

  const rawText = await callGroqDirect(SYSTEM_PROMPT_BRIEFING, payload, true, 800);
  let parsed = null;
  try { parsed = JSON.parse(rawText); } catch (e) {
    const m = String(rawText).match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
  }

  if (parsed && typeof parsed === "object") {
    return {
      title: cleanStr(parsed.title, 120) || "IGNIS AI Operational Fire Danger Briefing",
      threatLevel: ["high", "moderate", "low"].includes(parsed.threatLevel) ? parsed.threatLevel : "high",
      summary: cleanStr(parsed.summary, 600),
      keyRisks: cleanList(parsed.keyRisks, 4, 200),
      stagedRecommendations: cleanList(parsed.stagedRecommendations, 4, 200),
      briefingText: String(parsed.briefingText || parsed.summary || "").trim().slice(0, 1800),
    };
  }

  return {
    title: "IGNIS AI Operational Fire Danger Briefing",
    threatLevel: "high",
    summary: rawText.slice(0, 500),
    keyRisks: [],
    stagedRecommendations: [],
    briefingText: rawText.slice(0, 1800),
  };
}

// 3. Interactive Commander Chat Assistant
async function chat(rawBody) {
  if (!rawBody || typeof rawBody !== "object") throw httpError(400, "Chat request must be JSON.");
  const question = cleanStr(rawBody.question, 300);
  if (!question || question.length < 2) throw httpError(400, "Question is too short.");

  const context = rawBody.context || {};
  const payload = {
    question: question,
    currentDay: num(context.day, 1, 7, "day"),
    selectedZone: context.selectedZone ? cleanStr(context.selectedZone, 6) : null,
    totalAlerts: num(context.alertCount || 0, 0, 50, "alertCount"),
    stagedUnitsCount: num(context.stagedCount || 0, 0, 24, "stagedCount"),
    activeAlertsSummary: cleanList(context.alertsSummary, 8, 80),
    zoneConditions: context.zoneConditions || null,
  };

  const rawText = await callGroqDirect(SYSTEM_PROMPT_CHAT, payload, true, 450);
  let parsed = null;
  try { parsed = JSON.parse(rawText); } catch (e) {
    const m = String(rawText).match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
  }

  if (parsed && typeof parsed === "object") {
    return {
      reply: String(parsed.reply || "").trim().slice(0, 900),
      suggestedAction: cleanStr(parsed.suggestedAction, 140),
    };
  }

  return {
    reply: rawText.trim().slice(0, 900),
    suggestedAction: "",
  };
}

module.exports = { explain, briefing, chat, validate };
