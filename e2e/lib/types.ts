/**
 * Type definitions for E2E tests.
 */

export interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  input?: string;
}

export interface Task {
  id: string;
  topic_id: string;
  title: string;
  description: string | null;
  status: string;
  due_at: string | null;
  completed_at: string | null;
}

export interface RecallMemory {
  id: string;
  content: string;
  category: string | null;
  strength: number;
  relevance: number;
  created_at: string;
  access_count: number;
}

export interface TestFn {
  name: string;
  run: () => Promise<TestResult>;
}

export interface Config {
  cortex: {
    url: string;
    apiKey: string;
  };
  engramUrl: string;
  telegram?: {
    botToken: string;
    testUserId: string;
    testSupergroupId: string;
  };
  db: {
    cortexPath: string;
    wilsonPath: string;
  };
  timeouts: {
    llmResponse: number;
    delivery: number;
  };
}
