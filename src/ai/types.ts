export type Capability =
  | "reasoning" // complex business reasoning, planning
  | "coding" // software development
  | "copywriting" // marketing & business writing
  | "classification" // cheap labelling / extraction
  | "translation"
  | "research" // web research with sources
  | "vision" // image understanding
  | "image.generate"
  | "image.edit"
  | "speech.tts"
  | "speech.stt";

export const ALL_CAPABILITIES: Capability[] = [
  "reasoning",
  "coding",
  "copywriting",
  "classification",
  "translation",
  "research",
  "vision",
  "image.generate",
  "image.edit",
  "speech.tts",
  "speech.stt",
];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  reasoning: "Business reasoning & planning",
  coding: "Software development",
  copywriting: "Copywriting",
  classification: "Simple classification",
  translation: "Translation",
  research: "Web research (with sources)",
  vision: "Image understanding",
  "image.generate": "Image generation",
  "image.edit": "Image editing",
  "speech.tts": "Text-to-speech",
  "speech.stt": "Speech recognition",
};

export type ProviderId = "anthropic" | "openai" | "gemini" | "google-translate" | "deepl" | "openai-compatible";

export interface ModelInfo {
  id: string;
  label: string;
  capabilities: Capability[];
  /** Relative quality 0..1 for the router (editable per connection). */
  quality: number;
  /** USD per 1M tokens. */
  inputPer1M?: number;
  outputPer1M?: number;
  /** USD per generated image / per 1M characters translated / per minute of audio. */
  perImage?: number;
  perMillionChars?: number;
  perMinute?: number;
  /** Typical latency, used until real measurements exist. */
  latencyMs: number;
  priceSource: "published" | "estimate";
}

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  optional?: boolean;
}

export interface ProviderDescriptor {
  id: ProviderId;
  name: string;
  summary: string;
  docsUrl: string;
  credentialFields: CredentialField[];
  models: ModelInfo[];
}

export interface ProviderConnection {
  id: ProviderId;
  enabled: boolean;
  /** Capabilities the owner switched on for this provider. */
  capabilities: Capability[];
  monthlyLimitUsd: number;
  preferred: Partial<Record<Capability, string>>;
  fallbacks: Partial<Record<Capability, string[]>>;
  /** Overrides / discovered models. */
  models?: ModelInfo[];
  /** If set, only these workspaces may use this provider. */
  allowedWorkspaces?: string[];
  lastTest?: { ok: boolean; at: string; detail: string; models?: string[] };
  createdAt: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  images?: number;
  characters?: number;
  costUsd: number;
}

export interface TextRequest {
  capability: Capability;
  system?: string;
  prompt: string;
  /** JSON Schema the answer must follow (provider-native structured output where supported). */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  images?: { mime: string; b64: string }[];
}

export interface TextResult {
  text: string;
  usage: Usage;
  model: string;
}

export interface ResearchResult {
  text: string;
  sources: { url: string; title: string }[];
  usage: Usage;
  model: string;
}

export interface ImageRequest {
  prompt: string;
  size: { width: number; height: number };
  n?: number;
}

export interface ImageEditRequest {
  prompt: string;
  image: { mime: string; b64: string };
  mask?: { mime: string; b64: string };
}

export interface ImageResult {
  images: { mime: string; b64: string }[];
  usage: Usage;
  model: string;
  revisedPrompt?: string;
}

export interface TranslateRequest {
  texts: string[];
  target: string;
  source?: string;
}

export interface TranslateResult {
  texts: string[];
  detectedSource?: string;
  usage: Usage;
  model: string;
}

export interface LanguageCapability {
  code: string;
  name?: string;
  text: boolean;
  tts?: boolean;
  stt?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolLoopRequest {
  system: string;
  prompt: string;
  tools: ToolSpec[];
  maxTurns: number;
  runTool: (name: string, input: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>;
}

export interface ToolLoopResult {
  finalText: string;
  turns: number;
  usage: Usage;
  model: string;
  stoppedBecause: "done" | "max_turns" | "refusal";
}

export interface AdapterCreds {
  [key: string]: string;
}

/** What each provider implementation can do. Unsupported methods are simply absent. */
export interface ProviderAdapter {
  id: ProviderId;
  test(creds: AdapterCreds): Promise<{ ok: boolean; detail: string; models?: string[] }>;
  text?(model: ModelInfo, req: TextRequest, creds: AdapterCreds): Promise<TextResult>;
  research?(model: ModelInfo, query: string, opts: { maxUses: number; system?: string }, creds: AdapterCreds): Promise<ResearchResult>;
  toolLoop?(model: ModelInfo, req: ToolLoopRequest, creds: AdapterCreds): Promise<ToolLoopResult>;
  image?(model: ModelInfo, req: ImageRequest, creds: AdapterCreds): Promise<ImageResult>;
  editImage?(model: ModelInfo, req: ImageEditRequest, creds: AdapterCreds): Promise<ImageResult>;
  translate?(model: ModelInfo, req: TranslateRequest, creds: AdapterCreds): Promise<TranslateResult>;
  languages?(creds: AdapterCreds): Promise<LanguageCapability[]>;
  tts?(model: ModelInfo, req: { text: string; voice?: string; language?: string }, creds: AdapterCreds): Promise<{ mime: string; b64: string; usage: Usage; model: string }>;
}

export class CapabilityUnavailableError extends Error {
  constructor(
    public capability: Capability,
    public explanation: string,
  ) {
    super(explanation);
    this.name = "CapabilityUnavailableError";
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class ModelRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRefusalError";
  }
}
