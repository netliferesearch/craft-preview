import { readFileSync } from "node:fs";

// Decides what a workflow run should do from the GitHub event alone, so the client workflow
// carries no label logic and the behaviour is testable here.

export type Command = "up" | "down" | "sweep" | "skip";

export type TriggerEvent = {
  event_name: string;
  action?: string;
  label?: { name: string };
  pull_request?: {
    number: number;
    labels: { name: string }[];
    head: { ref: string; sha: string; repo: { full_name: string } | null };
  };
  repository: { full_name: string };
};

export function readEvent(eventName: string, eventPath: string): TriggerEvent {
  return { event_name: eventName, ...JSON.parse(readFileSync(eventPath, "utf8")) };
}

export function resolveCommand(event: TriggerEvent, labelName = "preview"): Command {
  if (event.event_name === "schedule" || event.event_name === "workflow_dispatch") return "sweep";
  if (event.event_name !== "pull_request" || !event.pull_request) return "skip";

  const pr = event.pull_request;
  // Forks get no secrets, so a preview could never be built for them.
  if (pr.head.repo?.full_name !== event.repository.full_name) return "skip";

  const hasLabel = pr.labels.some((l) => l.name === labelName);
  const eventLabel = event.label?.name === labelName;

  switch (event.action) {
    case "labeled":
      return eventLabel ? "up" : "skip";
    case "synchronize":
    case "reopened":
      return hasLabel ? "up" : "skip";
    case "unlabeled":
      return eventLabel ? "down" : "skip";
    case "closed":
      // down is idempotent, so a closed PR that never had a preview costs one lookup.
      return "down";
    default:
      return "skip";
  }
}
