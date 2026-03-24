export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
export type TaskPriority = "critical" | "high" | "medium" | "low";
export type TaskSource = "cowork" | "claude-code" | "manual";

export interface TaskContext {
  source: TaskSource;
  timestamp: string;
  message: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  source: TaskSource;
  assignee?: TaskSource;
  tags: string[];
  context: TaskContext[];
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookConfig {
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  secret?: string;
  headers?: Record<string, string>;
}

export type WebhookEvent =
  | "task.created"
  | "task.completed"
  | "task.updated"
  | "task.blocked"
  | "task.claimed";

export interface WebhookPayload {
  event: WebhookEvent;
  task: Task;
  timestamp: string;
  source: TaskSource;
}

export interface BridgeStore {
  tasks: Task[];
  webhooks: WebhookConfig[];
  lastSync: string;
}
