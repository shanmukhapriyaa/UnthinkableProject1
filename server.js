/**
 * Smart Resume Screener — backend
 * ---------------------------------
 * Endpoints:
 *   POST /api/extract-text   multipart file (pdf/txt) -> { text }
 *   POST /api/score          { candidateName, jobDescription, resumeText } -> scored result (LLM)
 *   GET  /api/candidates     -> shortlist of previously scored candidates, sorted by score
 *   DELETE /api/candidates   -> clear stored candidates
 *
 * Storage: a flat JSON file at data/candidates.json (swap for a real DB in production).
 */

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'candidates.json');
const MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-6';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ---------- storage helpers ----------
function readCandidates() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (err) {
    console.error('Failed to read candidates store:', err);
    return [];
  }
}

function writeCandidates(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

// ---------- text extraction (PDF / TXT) ----------
app.post('/api/extract-text', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const { originalname, buffer, mimetype } = req.file;

    let text = '';
    if (mimetype === 'application/pdf' || originalname.toLowerCase().endsWith('.pdf')) {
      const parsed = await pdfParse(buffer);
      text = parsed.text;
    } else {
      text = buffer.toString('utf-8');
    }

    text = text.replace(/\r\n/g, '\n').trim();
    if (!text) return res.status(422).json({ error: 'Could not extract any text from that file.' });

    res.json({ text, filename: originalname });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to extract text from file.' });
  }
});

// ---------- LLM scoring prompt ----------
function buildPrompt(jobDescription, resumeText) {
  return `You are an expert technical recruiter. Compare the RESUME against the JOB DESCRIPTION below.

JOB DESCRIPTION:
"""
${jobDescription}
"""

RESUME:
"""
${resumeText}
"""

Do the following:
1. Extract structured data from the resume: skills (technical + soft), work experience (role, company, approx. duration if stated), and education (degree, institution).
2. Identify which required qualifications from the job description are clearly met by the resume ("matched"), and which are not evidenced ("missing").
3. Rate overall fit on a 1-10 scale (10 = excellent fit).
4. Give a short justification (2-4 sentences) grounded in specific evidence from the resume.

Respond with ONLY valid JSON, no markdown fences, no commentary, matching this exact shape:
{
  "score": <integer 1-10>,
  "verdict": "<one short sentence summarizing fit>",
  "justification": "<2-4 sentence explanation citing specific resume evidence>",
  "matched_qualifications": ["<string>", ...],
  "missing_qualifications": ["<string>", ...],
  "extracted": {
    "skills": ["<string>", ...],
    "experience": [{"role": "<string>", "company": "<string>", "duration": "<string or empty>"}],
    "education": [{"degree": "<string>", "institution": "<string>"}]
  }
}`;
}

function parseJsonFromModel(raw) {
  // Model is asked for raw JSON, but strip code fences defensively.
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '');
  return JSON.parse(cleaned);
}

// ---------- scoring endpoint ----------
app.post('/api/score', async (req, res) => {
  try {
    const { candidateName, jobDescription, resumeText } = req.body || {};
    if (!jobDescription || jobDescription.trim().length < 20) {
      return res.status(400).json({ error: 'jobDescription is required (min 20 chars).' });
    }
    if (!resumeText || resumeText.trim().length < 20) {
      return res.status(400).json({ error: 'resumeText is required (min 20 chars).' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Set it in .env.' });
    }

    const prompt = buildPrompt(jobDescription, resumeText);

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    let parsed;
    try {
      parsed = parseJsonFromModel(rawText);
    } catch (parseErr) {
      console.error('Failed to parse model output as JSON:', rawText);
      return res.status(502).json({ error: 'Model returned an unparseable response. Try again.' });
    }

    const record = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      candidateName: candidateName || 'Unnamed candidate',
      scoredAt: new Date().toISOString(),
      score: parsed.score,
      verdict: parsed.verdict,
      justification: parsed.justification,
      matched_qualifications: parsed.matched_qualifications || [],
      missing_qualifications: parsed.missing_qualifications || [],
      extracted: parsed.extracted || {},
    };

    const all = readCandidates();
    all.push(record);
    writeCandidates(all);

    res.json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Scoring failed. Check server logs.' });
  }
});

// ---------- shortlist ----------
app.get('/api/candidates', (req, res) => {
  const all = readCandidates().sort((a, b) => (b.score || 0) - (a.score || 0));
  res.json(all);
});

app.delete('/api/candidates', (req, res) => {
  writeCandidates([]);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Smart Resume Screener running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set — /api/score will fail until you add it to .env');
  }
});
