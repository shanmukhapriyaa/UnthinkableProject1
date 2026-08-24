# ScanFit — Smart Resume Screener

Parses resumes (PDF or text), extracts structured candidate data, and uses an LLM to score
how well a candidate fits a job description — with a justification and a shortlist view.

## Features

- **Input**: paste a job description + resume text, or upload a resume as `.pdf` / `.txt`
- **Structured extraction**: skills, work experience, education — pulled out by the LLM
- **LLM-based match scoring**: 1–10 fit score, matched/missing qualifications, justification
- **Shortlist dashboard**: every scored candidate is stored and ranked by score
- **Frontend**: single-page dashboard (`public/index.html`), no framework/build step needed

## Architecture

```
Browser (public/index.html)
   │  fetch()
   ▼
Express server (server.js)
   ├── POST /api/extract-text   → pdf-parse extracts text from uploaded PDF/TXT
   ├── POST /api/score          → builds prompt, calls Claude (Anthropic API),
   │                               parses structured JSON, stores result
   ├── GET  /api/candidates     → returns shortlist sorted by score
   └── DELETE /api/candidates   → clears the shortlist
   │
   ▼
data/candidates.json   (flat-file store — swap for Postgres/Mongo in production)
```

**Why this shape:** the LLM does the semantic work (matching, extraction, scoring)
instead of brittle keyword regexes, so it generalizes to job descriptions and resumes
it has never seen. The backend only builds the prompt, validates the response shape,
and persists it — all business logic that decides *pass/fail* stays server-side so it
can't be tampered with from the browser.

## LLM prompt

The exact prompt sent to the model (`buildPrompt` in `server.js`) asks for structured JSON only:

```
You are an expert technical recruiter. Compare the RESUME against the JOB DESCRIPTION below.

JOB DESCRIPTION:
"""
<job description text>
"""

RESUME:
"""
<resume text>
"""

Do the following:
1. Extract structured data from the resume: skills (technical + soft), work experience
   (role, company, approx. duration if stated), and education (degree, institution).
2. Identify which required qualifications from the job description are clearly met by
   the resume ("matched"), and which are not evidenced ("missing").
3. Rate overall fit on a 1-10 scale (10 = excellent fit).
4. Give a short justification (2-4 sentences) grounded in specific evidence from the resume.

Respond with ONLY valid JSON ... { score, verdict, justification,
matched_qualifications, missing_qualifications, extracted: { skills, experience, education } }
```

Keeping the schema explicit in the prompt (rather than free text) is what lets the frontend
render chips/lists directly from the response without any further NLP on our side.

## Setup

Requires Node.js 18+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
git clone <your-repo-url>
cd smart-resume-screener
npm install
cp .env.example .env
# edit .env and paste your ANTHROPIC_API_KEY
npm start
```

Open **http://localhost:3000**.

## Project structure

```
.
├── server.js            # Express API (extraction, scoring, storage)
├── package.json
├── .env.example
├── public/
│   └── index.html       # frontend dashboard
├── data/
│   └── candidates.json  # created at runtime (gitignored)
└── README.md
```

## Possible extensions

- Swap `data/candidates.json` for a real database (Postgres/Mongo) behind the same
  `readCandidates`/`writeCandidates` interface
- Batch-upload multiple resumes against one job description
- Add auth so each recruiter only sees their own shortlist
- Stream the LLM response for a live "typing" effect while scoring

## Demo video checklist

When recording the 2–3 min walkthrough, show: pasting/choosing a job description →
uploading a PDF resume → running a scan → the score, matched/missing chips, and
extracted skills/experience/education → the Shortlist tab with multiple ranked candidates.
