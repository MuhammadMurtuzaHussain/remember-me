export type Importance = "low" | "medium" | "high";

export type MemoryExtraction = {
  summary: string;
  people: string[];
  importance: Importance;
  eventTitle: string | null;
  eventTimeText: string | null;
  memoryCue: string;
  confidence: number;
  needsConfirmation: boolean;
};

export type Memory = MemoryExtraction & {
  id: number;
  messageId: number;
  sourceText: string;
  senderName: string;
  sentAt: string;
  chatId: string;
  createdAt: string;
};

export type Answer = {
  answer: string;
  memoryIds: number[];
  uncertain: boolean;
};

export type ExtractInput = { text: string; sender: string; sentAt: string };

/** The only thing the app needs from a language model. */
export interface Llm {
  extract(input: ExtractInput): Promise<MemoryExtraction>;
  answer(question: string, memories: Memory[]): Promise<Answer>;
}
