import { GoogleGenAI, Type } from '@google/genai';

const MODEL_NAME = 'gemini-4-hydrogen';

function getApiKey(): string | undefined {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === 'MY_GEMINI_API_KEY') return undefined;
  return key;
}

export function isGeminiConfigured(): boolean {
  return Boolean(getApiKey());
}

function getClient(): GoogleGenAI {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('Gemini API key is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : '';
      if (/API_KEY_INVALID|PERMISSION_DENIED|NOT_FOUND|429|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
        throw err;
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export interface AiCodeFinding {
  lineNumber: number;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  errorMessage: string;
  rootCause: string;
}

export async function analyzeCodeWithGemini(input: {
  filePath: string;
  language: string;
  content: string;
  existingFindings: string[];
}): Promise<AiCodeFinding[]> {
  const ai = getClient();
  const truncated = input.content.slice(0, 14000);

  const response = await withRetry(() =>
    ai.models.generateContent({
      model: MODEL_NAME,
      contents: `Analyze this ${input.language} file (${input.filePath}) for real, concrete software bugs, security vulnerabilities, race conditions, null-reference crashes, or logic errors.
Do NOT report stylistic nitpicks or issues already listed below. Return an empty array if no additional real bugs exist.
Already detected issues: ${input.existingFindings.join('; ') || 'None'}

CODE:
${truncated}`,
      config: {
        systemInstruction:
          'You are a principal software security & reliability engineer. Identify only verifiable, high-signal bugs with accurate 1-indexed line numbers.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              lineNumber: { type: Type.INTEGER },
              category: { type: Type.STRING },
              severity: { type: Type.STRING },
              title: { type: Type.STRING },
              errorMessage: { type: Type.STRING },
              rootCause: { type: Type.STRING },
            },
            required: ['lineNumber', 'category', 'severity', 'title', 'errorMessage', 'rootCause'],
          },
        },
      },
    }),
  );

  const raw = (response.text ?? '[]').trim();
  const parsed = JSON.parse(raw) as AiCodeFinding[];
  return parsed.slice(0, 5).map((item) => ({
    ...item,
    lineNumber: Math.max(1, item.lineNumber || 1),
    severity: ['low', 'medium', 'high', 'critical'].includes(item.severity?.toLowerCase())
      ? (item.severity.toLowerCase() as AiCodeFinding['severity'])
      : 'medium',
  }));
}

export interface AiPatchResult {
  proposedCode: string;
  rootCause: string;
  explanation: string;
  preventionTips: string;
  relatedConcepts: string[];
}

const PATCH_FALLBACK_MODELS = [MODEL_NAME, 'gemini-3.1-flash-lite'] as const;

export async function generatePatchWithGemini(input: {
  filePath: string;
  language: string;
  fullFileContent: string;
  bugTitle: string;
  bugCategory: string;
  errorMessage: string;
  rootCause: string;
  lineNumber: number;
}): Promise<AiPatchResult> {
  const ai = getClient();
  const promptContents = `Fix the following software bug in "${input.filePath}" (${input.language}).
Bug Title: ${input.bugTitle}
Category: ${input.bugCategory}
Line: ${input.lineNumber}
Error Message: ${input.errorMessage}
Known Root Cause: ${input.rootCause}

Requirements:
1. Return the COMPLETE, valid, ready-to-save updated file content in "proposedCode" (do not truncate or use placeholders like "// ... rest of file").
2. Make minimal, surgical changes that fix the bug cleanly without breaking unrelated exports or behavior.
3. Explain clearly why the fix resolves the root cause and how to prevent this class of bug.

ORIGINAL FILE:
${input.fullFileContent.slice(0, 24000)}`;

  const requestConfig = {
    systemInstruction:
      'You are an autonomous software repair engineer. Always output complete, syntactically valid source code in proposedCode.',
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        proposedCode: { type: Type.STRING },
        rootCause: { type: Type.STRING },
        explanation: { type: Type.STRING },
        preventionTips: { type: Type.STRING },
        relatedConcepts: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
      },
      required: ['proposedCode', 'rootCause', 'explanation', 'preventionTips', 'relatedConcepts'],
    },
  };

  let lastError: unknown;
  let response: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;

  for (const model of PATCH_FALLBACK_MODELS) {
    try {
      response = await withRetry(
        () =>
          ai.models.generateContent({
            model,
            contents: promptContents,
            config: requestConfig,
          }),
        1,
      );
      break;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(msg)) {
        continue;
      }
      throw err;
    }
  }

  if (!response) {
    const msg = lastError instanceof Error ? lastError.message : 'Gemini quota exceeded.';
    if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) {
      throw new Error(
        'Gemini free-tier request quota exceeded across available models. Select a billing-enabled API key in Settings > Secrets or try again later.',
      );
    }
    throw lastError instanceof Error ? lastError : new Error(msg);
  }

  const raw = (response.text ?? '{}').trim();
  const parsed = JSON.parse(raw) as AiPatchResult;
  if (!parsed.proposedCode || parsed.proposedCode.trim().length === 0) {
    throw new Error('Gemini returned an empty patch.');
  }
  return parsed;
}

export interface AiPreventionRecommendation {
  title: string;
  priority: 'High' | 'Medium' | 'Low';
  patternEvidence: string;
  actionableGuidance: string;
}

export async function generatePatternRecommendationsWithGemini(input: {
  projectName: string;
  totalBugs: number;
  topCategories: Array<{ category: string; count: number }>;
  hotspotFiles: Array<{ filePath: string; count: number }>;
  sampleErrors: string[];
}): Promise<AiPreventionRecommendation[]> {
  const ai = getClient();

  const response = await withRetry(() =>
    ai.models.generateContent({
      model: MODEL_NAME,
      contents: `Generate 3 to 5 concrete engineering prevention recommendations grounded strictly in this project's real historical bug records:
Project: ${input.projectName}
Total historical bugs: ${input.totalBugs}
Top bug categories: ${JSON.stringify(input.topCategories)}
Frequently affected files: ${JSON.stringify(input.hotspotFiles)}
Repeated error messages: ${JSON.stringify(input.sampleErrors.slice(0, 10))}`,
      config: {
        systemInstruction:
          'You are a staff software quality architect. Base every recommendation directly on the provided historical bug data.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              priority: { type: Type.STRING },
              patternEvidence: { type: Type.STRING },
              actionableGuidance: { type: Type.STRING },
            },
            required: ['title', 'priority', 'patternEvidence', 'actionableGuidance'],
          },
        },
      },
    }),
  );

  const raw = (response.text ?? '[]').trim();
  return JSON.parse(raw) as AiPreventionRecommendation[];
}
