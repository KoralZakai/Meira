# LUMI-APP — MASTER CLAUDE CODE PROMPT (SMART MBTI VERSION)
# 4-Question Quick Assessment + Behavioral Learning
# Paste this entire file into Claude Code in VS Code

---

## BEFORE YOU WRITE ANY CODE — READ FIRST

1. List every file in this project
2. Read: package.json, app.json, .env (if exists)
3. Read every file in: src/services/, src/screens/, src/components/, src/types/
4. Identify what exists, what is broken, what is missing
5. Then proceed section by section below
6. DO NOT overwrite .env or app.json unless told explicitly
7. DO NOT delete working code — fix or upgrade it

---

## KEY DIFFERENCE: SMART MBTI (NOT 30 QUESTIONS)

**This version uses:**
- ✅ 4-question quick assessment (2 minutes)
- ✅ Behavioral learning from task patterns
- ✅ Progressive confidence building (Days 1-15)
- ✅ Personality refinement suggestions

**NOT:**
- ❌ 30-question questionnaire (users quit)

---

## ARCHITECTURE

```
┌──────────────────────────────────┐
│  User WhatsApp / App             │
│  "I'm sad. What should I do?"    │
│  "Call John tomorrow 3pm"        │
└────────────┬─────────────────────┘
             │
   ┌─────────┴──────────┐
   ▼                    ▼
┌─────────────────┐  ┌──────────────────────┐
│  Day 0:         │  │  Days 1-15:          │
│  Quick MBTI     │  │  Behavioral Learning │
│  (4 questions)  │  │  (from task patterns)│
├─────────────────┤  ├──────────────────────┤
│  Initial type   │  │  Observe behavior    │
│  Confidence: 0.4│  │  Record signals      │
└─────────────────┘  │  Refine personality  │
                     │  Confidence: 0.3→0.9 │
                     └──────────────────────┘
```

---

## SECTION 0 — ENVIRONMENT & CONFIG

### .env
```
# Existing
EXPO_PUBLIC_NEBIUS_API_KEY=v1.CmMK...
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=AIza...
EXPO_PUBLIC_GOOGLE_OAUTH_CLIENT_ID=123456....apps.googleusercontent.com

# WhatsApp
WHATSAPP_BUSINESS_ACCOUNT_ID=102345678901234
WHATSAPP_BUSINESS_PHONE_ID=102345678901234
WHATSAPP_API_TOKEN=EAABsbCS...
WHATSAPP_WEBHOOK_VERIFY_TOKEN=random_string_12345

# LLM
LLM_PROVIDER=llama
LLM_ENDPOINT=https://api.together.ai/v1
LLM_API_KEY=your_together_api_key
LLM_MODEL=meta-llama/Llama-3.1-70B-Instruct

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/lumi_app

# Server
FLASK_ENV=production
PORT=8000
```

---

## SECTION 1 — TYPES (src/types/index.ts)

ADD these new interfaces:

```typescript
// ─── MBTI PERSONALITY ───
export type MBTIType =
  | 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP'
  | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ'
  | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP';

export interface MBTIProfile {
  type: MBTIType;
  energySource: 'Extrovert' | 'Introvert';
  informationProcessing: 'Sensing' | 'iNtuition';
  decisionMaking: 'Thinking' | 'Feeling';
  lifeOrientation: 'Judging' | 'Perceiving';
  pacePreference: 'steady' | 'flexible' | 'aggressive';
  deadlineStyle: 'early_bird' | 'deadline_driven';
  socialOverload: 'needs_breaks' | 'energized_by_interaction';
  riskTolerance: 'conservative' | 'balanced' | 'experimental';
  communicationStyle: 'direct' | 'diplomatic' | 'analytical';
}

export interface PersonalitySignal {
  id: string;
  userId: string;
  signalType: 'suggestion_accepted' | 'suggestion_rejected' | 
             'detail_requested' | 'big_picture_preferred' |
             'logic_motivated' | 'emotion_motivated' |
             'fixed_task_completed' | 'flexible_task_completed';
  dichotomy: 'E/I' | 'S/N' | 'T/F' | 'J/P';
  confidence: number;
  timestamp: number;
}

export interface LearnedPersonality {
  userId: string;
  quickAssessmentType?: MBTIType;
  quickAssessmentConfidence: number; // ~0.4
  behavioralType?: MBTIType;
  behavioralConfidence?: number; // 0.3→0.9
  finalType: MBTIType;
  finalConfidence: number;
  signalCount: number;
  lastUpdated: number;
}

// ─── KNOWLEDGE BASE ───
export interface KBEntry {
  id: string;
  category: 'belief' | 'policy' | 'happiness_driver' | 'energy_pattern' | 'value';
  text: string;
  context?: string;
  source?: 'user_entered' | 'selected_book' | 'company_policy';
  active: boolean;
  createdAt: number;
}

export interface UserKnowledgeBase {
  userId: string;
  entries: KBEntry[];
  lastUpdated: number;
}

// ─── WHATSAPP ───
export interface WhatsAppMessage {
  id: string;
  waMessageId: string;
  userId: string;
  fromPhone: string;
  content: string;
  messageType: 'text' | 'voice' | 'image';
  isFromUser: boolean;
  inferredIntent?: 'create_task' | 'ask_motivation' | 'ask_schedule' | 'other';
  taskCreatedFromMessage?: string;
  timestamp: number;
}

// ─── EXTEND UserProfile ───
export interface UserProfile {
  // ... existing fields ...
  mbtiType?: MBTIType;
  mbtiProfile?: MBTIProfile;
  whatsAppPhone?: string;
  whatsAppConnected: boolean;
  knowledgeBase?: UserKnowledgeBase;
  mbtiAssessmentComplete: boolean;
  createdAt: number;
}
```

---

## SECTION 2 — MBTI CONSTANTS (src/constants/mbti.ts)

CREATE with ONLY the 4 quick questions (not 30):

```typescript
import { MBTIType, MBTIProfile } from '../types';

// 4 QUICK QUESTIONS (One per dichotomy)
export const QUICK_MBTI_QUESTIONS = [
  {
    id: 'ei',
    text: 'How do you prefer to recharge?',
    textHe: 'איך אתה מעדיף להטעין אנרגיה?',
    options: [
      { text: 'Spend time with friends/in social settings', textHe: 'בילוי עם חברים/בהתכנסויות', score: 'E' },
      { text: 'Spend quiet time alone or with close people', textHe: 'זמן שקט לבד או עם אנשים קרובים', score: 'I' },
    ],
  },
  {
    id: 'sn',
    text: 'When learning something new, what helps?',
    textHe: 'כשאתה לומד משהו חדש, מה עוזר?',
    options: [
      { text: 'Concrete examples and practical how-to steps', textHe: 'דוגמאות קונקרטיות וצעדים מעשיים', score: 'S' },
      { text: 'Big picture ideas and underlying patterns', textHe: 'רעיונות גדולים ודפוסים בסיסיים', score: 'N' },
    ],
  },
  {
    id: 'tf',
    text: 'When I suggest something, I prefer you...',
    textHe: 'כשאני מציע משהו, אני מעדיף שאתה...',
    options: [
      { text: 'Give me the logic and evidence', textHe: 'תן לי את ההיגיון והראיות', score: 'T' },
      { text: 'Show me how it helps my wellbeing', textHe: 'הראה לי איך זה עוזר לרווחתי', score: 'F' },
    ],
  },
  {
    id: 'jp',
    text: 'Your schedule preference?',
    textHe: 'העדפת התכנון שלך?',
    options: [
      { text: 'Clear plan with deadlines keeps me on track', textHe: 'תוכנית ברורה עם תאריכי סיום שומרים על מסלול', score: 'J' },
      { text: 'Flexibility to adapt as I go works better', textHe: 'גמישות להתאמה תוך כדי התנעות טוב יותר', score: 'P' },
    ],
  },
];

// All 16 MBTI Profiles
export const MBTI_PROFILES: Record<MBTIType, MBTIProfile> = {
  'INTJ': {
    type: 'INTJ',
    energySource: 'Introvert',
    informationProcessing: 'iNtuition',
    decisionMaking: 'Thinking',
    lifeOrientation: 'Judging',
    pacePreference: 'aggressive',
    deadlineStyle: 'deadline_driven',
    socialOverload: 'needs_breaks',
    riskTolerance: 'balanced',
    communicationStyle: 'direct',
  },
  // ... continue for all 16 types
};

// Communication styles
export const MBTI_COMMUNICATION: Record<MBTIType, {
  motivationalTone: string;
  reminderFrequency: 'sparse' | 'moderate' | 'frequent';
  suggestionStyle: string;
  breakFrequency: string;
  idealResponseLength: 'brief' | 'moderate' | 'detailed';
}> = {
  'INTJ': {
    motivationalTone: 'Strategic. Here\'s the long-term impact.',
    reminderFrequency: 'sparse',
    suggestionStyle: 'Evidence-based, direct, no fluff.',
    breakFrequency: 'After deep work blocks (90+ min)',
    idealResponseLength: 'brief',
  },
  // ... continue for all 16
};
```

---

## SECTION 3 — DATABASE SCHEMA

### database/migrations/001_lumi_app_schema.sql

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  language VARCHAR(2) DEFAULT 'en',
  mbti_type VARCHAR(4),
  mbti_confidence DECIMAL(3,2) DEFAULT 0.4,
  whatsapp_phone VARCHAR(20) UNIQUE,
  whatsapp_connected BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_whatsapp (whatsapp_phone)
);

-- Personality Signals (behavioral learning)
CREATE TABLE personality_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signal_type VARCHAR(50),
  dichotomy VARCHAR(10),
  confidence DECIMAL(3,2),
  timestamp TIMESTAMP DEFAULT NOW(),
  INDEX idx_user_signals (user_id),
  INDEX idx_dichotomy (dichotomy)
);

-- Knowledge Base
CREATE TABLE user_kb_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category VARCHAR(50),
  text TEXT NOT NULL,
  context TEXT,
  source VARCHAR(50),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_user_kb (user_id)
);

-- Tasks
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  category VARCHAR(50),
  priority VARCHAR(20),
  is_fixed BOOLEAN,
  fixed_time VARCHAR(5),
  duration_minutes INT,
  date DATE,
  status VARCHAR(20),
  whatsapp_message_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_user_tasks (user_id),
  INDEX idx_whatsapp_msg (whatsapp_message_id)
);

-- WhatsApp Messages
CREATE TABLE whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wa_message_id VARCHAR(255) UNIQUE,
  from_phone VARCHAR(20),
  content TEXT,
  message_type VARCHAR(20),
  is_from_user BOOLEAN,
  timestamp TIMESTAMP DEFAULT NOW(),
  INDEX idx_user_messages (user_id)
);
```

---

## SECTION 4 — PERSONALITY LEARNING SERVICE

### src/services/PersonalityLearningService.ts — CREATE:

```typescript
import { Pool } from 'pg';
import { PersonalitySignal, MBTIType, LearnedPersonality } from '../types';
import { MBTI_PROFILES } from '../constants/mbti';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const PersonalityLearningService = {
  async recordSignal(
    userId: string,
    signalType: string,
    dichotomy: string,
    confidence: number
  ): Promise<void> {
    await pool.query(
      `INSERT INTO personality_signals (user_id, signal_type, dichotomy, confidence)
       VALUES ($1, $2, $3, $4)`,
      [userId, signalType, dichotomy, confidence]
    );
  },

  async getLearnedPersonality(userId: string): Promise<LearnedPersonality | null> {
    const res = await pool.query(
      `SELECT mbti_type, mbti_confidence FROM users WHERE id = $1`,
      [userId]
    );

    if (!res.rows[0]) return null;

    const user = res.rows[0];
    const signals = await pool.query(
      `SELECT dichotomy, COUNT(*) as count FROM personality_signals
       WHERE user_id = $1 GROUP BY dichotomy`,
      [userId]
    );

    const signalCount = signals.rows.reduce((sum, row) => sum + row.count, 0);

    // Infer type from signals
    let inferredType = '';
    let behavioralConfidence = Math.min(signalCount / 10, 1.0); // Max at 10 signals

    for (const signal of signals.rows) {
      // Simple majority rule per dichotomy
      // In production: use Bayesian posterior calculation
      inferredType += signal.dichotomy.includes('E') ? 'E' : 'I'; // placeholder
    }

    return {
      userId,
      quickAssessmentType: user.mbti_type,
      quickAssessmentConfidence: user.mbti_confidence || 0.4,
      behavioralType: inferredType as MBTIType,
      behavioralConfidence,
      finalType: user.mbti_type,
      finalConfidence: Math.max(user.mbti_confidence || 0.4, behavioralConfidence),
      signalCount,
      lastUpdated: Date.now(),
    };
  },

  async suggestPersonalityRefinement(userId: string): Promise<string | null> {
    const learned = await this.getLearnedPersonality(userId);
    
    if (!learned || learned.signalCount < 10) {
      return null; // Not enough data yet
    }

    if (learned.behavioralConfidence >= 0.8 && learned.behavioralType !== learned.quickAssessmentType) {
      return `I notice you behave like a ${learned.behavioralType}, not ${learned.quickAssessmentType}. 
              Should I adjust? (I'm ${Math.round(learned.behavioralConfidence * 100)}% confident)`;
    }

    if (learned.signalCount >= 15 && learned.behavioralConfidence >= 0.85) {
      return `My assessment is spot on (${Math.round(learned.behavioralConfidence * 100)}% confident). 
              I know you pretty well now!`;
    }

    return null;
  },
};
```

---

## SECTION 5 — LLM SERVICE (PERSONALITY-AWARE AGENT)

### src/services/LLMService.ts — CREATE or OVERWRITE:

```typescript
import OpenAI from 'openai';
import { Task, UserProfile, LearnedPersonality } from '../types';
import { preprocessTranscript } from './SpeechService';
import { MBTI_COMMUNICATION } from '../constants/mbti';
import { PersonalityLearningService } from './PersonalityLearningService';

const getLLMClient = () => new OpenAI({
  apiKey: process.env.LLM_API_KEY || '',
  baseURL: process.env.LLM_ENDPOINT || 'https://api.together.ai/v1',
  dangerouslyAllowBrowser: true,
});

const MODEL = process.env.LLM_MODEL || 'meta-llama/Llama-3.1-70B-Instruct';

const LUMI_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'infer_task_details',
      description: 'Extract task: category, time, location, contact, deadline',
      parameters: {
        type: 'object',
        properties: { task_text: { type: 'string' } },
        required: ['task_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_personality_aware_response',
      description: 'Generate response matching user personality (max 2 sentences)',
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string' },
          user_type: { type: 'string' },
          language: { type: 'string' },
        },
        required: ['intent', 'user_type', 'language'],
      },
    },
  },
];

const getSystemPrompt = (
  profile: UserProfile,
  learned: LearnedPersonality | null,
  language: 'en' | 'he' = 'en'
): string => {
  const comm = learned && MBTI_COMMUNICATION[learned.finalType];
  const finalType = learned?.finalType || profile.mbtiType || 'UNKNOWN';

  return `
You are Lumi, a warm, personality-aware task AI for WhatsApp.

USER PROFILE:
- Name: ${profile.name}
- MBTI: ${finalType}
${comm ? `- Tone: ${comm.motivationalTone}` : ''}
${comm ? `- Response length: ${comm.idealResponseLength}` : ''}

YOUR JOB:
1. Extract task details (minimal input → rich details)
2. Create task with smart inference
3. Respond warmly, personality-aware
4. Keep responses SHORT (WhatsApp-friendly, max 2 sentences)

${comm ? `
PERSONALITY GUIDE:
- Talk in ${comm.communicationStyle} style
- Suggestion style: ${comm.suggestionStyle}
- Response length: ${comm.idealResponseLength}
` : ''}

Respond in ${language === 'he' ? 'Hebrew' : 'English'}.
`;
};

export async function handleWhatsAppMessage(
  messageContent: string,
  userProfile: UserProfile,
  learned: LearnedPersonality | null
): Promise<{ type: string; text: string; textHe?: string }> {
  const client = getLLMClient();
  const language = (userProfile.language || 'en') as 'en' | 'he';
  const cleaned = preprocessTranscript(messageContent, language);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: getSystemPrompt(userProfile, learned, language),
    },
    { role: 'user', content: cleaned },
  ];

  let iterations = 0;
  const MAX_ITER = 5;

  while (iterations < MAX_ITER) {
    iterations++;

    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: LUMI_TOOLS,
      tool_choice: 'auto',
      max_tokens: 1000,
    });

    const choice = response.choices[0];
    messages.push({
      role: 'assistant',
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
    });

    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      break;
    }

    // Execute tools
    for (const toolCall of choice.message.tool_calls) {
      const input = JSON.parse(toolCall.function.arguments);
      const result = await executeTool(toolCall.function.name, input, userProfile, learned);
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Extract final response
  const lastAssistantMsg = messages.reverse().find(m => m.role === 'assistant');
  const finalText = lastAssistantMsg && typeof lastAssistantMsg.content === 'string'
    ? lastAssistantMsg.content
    : 'Got it! Processing your message...';

  return { type: 'task_created', text: finalText };
}

async function executeTool(toolName: string, input: any, profile: UserProfile, learned: LearnedPersonality | null): Promise<any> {
  switch (toolName) {
    case 'infer_task_details':
      return {
        category: 'general',
        priority: 'need_to',
        durationMinutes: 30,
        confidence: 0.7,
      };

    case 'generate_personality_aware_response':
      const { user_type, language } = input;
      const responses: Record<string, Record<string, string>> = {
        'INTJ,en': '✓ Noted. I\'ll execute.',
        'ENFP,en': '✓ Added! This could be fun!',
      };
      return { text: responses[`${user_type},${language}`] || '✓ Task created!' };

    default:
      return { error: 'Unknown tool' };
  }
}
```

---

## SECTION 6 — FRONTEND SCREENS

### src/screens/QuickMBTIScreen.tsx — CREATE:

```typescript
import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { COLORS } from '../constants/theme';
import { QUICK_MBTI_QUESTIONS } from '../constants/mbti';

export default function QuickMBTIScreen({ onComplete }: { onComplete: (type: string) => void }) {
  const [currentQ, setCurrentQ] = useState(0);
  const [scores, setScores] = useState({ E: 0, I: 0, S: 0, N: 0, T: 0, F: 0, J: 0, P: 0 });

  const handleAnswer = (score: string) => {
    setScores(prev => ({ ...prev, [score]: prev[score] + 1 }));
    if (currentQ < QUICK_MBTI_QUESTIONS.length - 1) {
      setCurrentQ(currentQ + 1);
    } else {
      finishAssessment();
    }
  };

  const finishAssessment = () => {
    const type = (
      (scores.E >= scores.I ? 'E' : 'I') +
      (scores.S >= scores.N ? 'S' : 'N') +
      (scores.T >= scores.F ? 'T' : 'F') +
      (scores.J >= scores.P ? 'J' : 'P')
    ) as any;
    onComplete(type);
  };

  const q = QUICK_MBTI_QUESTIONS[currentQ];
  const progress = ((currentQ + 1) / QUICK_MBTI_QUESTIONS.length) * 100;

  return (
    <ScrollView style={[styles.container, { backgroundColor: COLORS.lightBg }]}>
      <Text style={styles.title}>Quick Personality Check 🧭</Text>
      <Text style={styles.subtitle}>2 minutes to personalize Lumi</Text>

      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${progress}%` }]} />
      </View>

      <Text style={styles.question}>{q.text}</Text>

      <View style={styles.options}>
        {q.options.map((opt, i) => (
          <Pressable
            key={i}
            style={styles.optionBtn}
            onPress={() => handleAnswer(opt.score)}
          >
            <Text style={styles.optionText}>{opt.text}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.progress}>Q{currentQ + 1}/4</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 28, fontWeight: 'bold', marginTop: 20, marginBottom: 8 },
  subtitle: { fontSize: 14, color: COLORS.lightTextSecondary, marginBottom: 20 },
  progressBar: { height: 4, backgroundColor: COLORS.lightBorder, borderRadius: 2, marginBottom: 30, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: COLORS.purple },
  question: { fontSize: 18, fontWeight: '600', marginBottom: 20 },
  options: { gap: 12, marginBottom: 30 },
  optionBtn: { padding: 16, backgroundColor: COLORS.lightCard, borderRadius: 12, borderWidth: 2, borderColor: COLORS.lightBorder },
  optionText: { color: COLORS.lightText, fontSize: 16 },
  progress: { textAlign: 'center', color: COLORS.lightTextSecondary },
});
```

---

## SECTION 7 — FASTAPI WHATSAPP WEBHOOK

### server/main.py — CREATE:

```python
from fastapi import FastAPI, Request, BackgroundTasks
from fastapi.responses import JSONResponse
import json
import logging
import os

from database_service import DatabaseService
from whatsapp_service import WhatsAppService
from lumi_agent import handle_whatsapp_message
from personality_learning_service import PersonalityLearningService

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Lumi-App", version="1.0")

@app.post("/webhook/whatsapp")
async def whatsapp_webhook(request: Request, background_tasks: BackgroundTasks):
  """Handle incoming WhatsApp messages"""
  body = await request.json()
  
  msg = body.get("entry", [{}])[0].get("changes", [{}])[0].get("value", {}).get("messages", [{}])[0]
  if not msg.get("id"):
    return {"status": "ok"}
  
  phone = msg.get("from")
  content = msg.get("text", {}).get("body", "")
  msg_id = msg.get("id")
  
  await WhatsAppService.mark_as_read(msg_id)
  
  user = await DatabaseService.get_user_by_whatsapp(phone)
  if not user:
    user = {"id": phone, "name": "User", "whatsAppPhone": phone, "language": "en", "createdAt": int(time.time())}
    await DatabaseService.save_user(user)
  
  learned = await PersonalityLearningService.getLearnedPersonality(user["id"])
  
  lumi_response = await handle_whatsapp_message(content, user, learned)
  
  await WhatsAppService.send_message(phone, lumi_response["text"])
  
  return {"status": "ok"}

@app.get("/webhook/whatsapp")
async def verify_webhook(request: Request):
  mode = request.query_params.get("hub.mode")
  token = request.query_params.get("hub.verify_token")
  challenge = request.query_params.get("hub.challenge")
  
  verify_token = os.getenv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", "")
  
  if mode == "subscribe" and token == verify_token:
    return int(challenge) if challenge else 200
  
  return {"error": "Invalid"}, 403

@app.get("/health")
async def health():
  return {"status": "ok"}
```

---

## SECTION 8 — VERIFY & RUN

After Claude Code builds:

1. **Set up PostgreSQL:**
   ```bash
   psql -f database/migrations/001_lumi_app_schema.sql
   ```

2. **Start backend:**
   ```bash
   python -m uvicorn server.main:app --reload --port 8000
   ```

3. **Start frontend:**
   ```bash
   npx expo start
   ```

4. **Test:**
   - [ ] Quick MBTI screen loads (4 questions)
   - [ ] Takes 2 minutes to complete
   - [ ] Shows inferred type: "You're INTJ"
   - [ ] WhatsApp webhook responds to verification
   - [ ] Send test WhatsApp: "Call John tomorrow 3pm"
   - [ ] Lumi responds warmly in <5 seconds

---

## KEY DIFFERENCES FROM 30-QUESTION VERSION

✅ **4 questions** (not 30) — 2 min completion (not 15 min)
✅ **Behavioral learning** — Lumi learns from actions, not just self-report
✅ **Progressive confidence** — 0.4 → 0.9+ over 2 weeks
✅ **Non-intrusive** — Learning happens in background
✅ **Self-correcting** — Catches personality mismatches automatically

---

## NEXT PHASE: ADD RL (Reinforcement Learning)

After MBTI + WhatsApp work, I'll add:
- Thompson Sampling for task ordering
- Reward signals on completion
- Multi-armed bandit optimization

Just ask when ready!

