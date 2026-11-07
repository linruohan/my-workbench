/**
 * Track background shell jobs and surface completion notices (DSH jobs notify).
 */

import { isTauriRuntime } from "../lib/paths";

export type WatchedJob = {
  threadId: string;
  jobId: string;
  description: string;
  status: string;
  done: boolean;
  /** Pending notice for the owning session; cleared after delivery or job_output. */
  pendingNotice: string | null;
};

const watched = new Map<string, WatchedJob>();

export function trackBackgroundJob(
  threadId: string,
  jobId: string,
  description: string,
): void {
  if (!threadId || !jobId) return;
  watched.set(jobId, {
    threadId,
    jobId,
    description: description.trim() || "后台命令",
    status: "running",
    done: false,
    pendingNotice: null,
  });
}

export function clearJobNotice(jobId: string): void {
  const hit = watched.get(jobId);
  if (!hit) return;
  hit.pendingNotice = null;
}

export function takePendingJobNotices(threadId: string): string[] {
  const out: string[] = [];
  for (const job of watched.values()) {
    if (job.threadId !== threadId || !job.pendingNotice) continue;
    out.push(job.pendingNotice);
    job.pendingNotice = null;
  }
  return out;
}

export function listWatchedRunning(threadId?: string): WatchedJob[] {
  return [...watched.values()].filter(
    (job) => !job.done && (!threadId || job.threadId === threadId),
  );
}

type JobListRow = {
  id: string;
  description: string;
  status: string;
  code: number | null;
  truncated: boolean;
};

type JobOutputHit = {
  id: string;
  status: string;
  code: number | null;
  output: string;
  stderr: string;
  truncated: boolean;
  done: boolean;
};

/** Poll Tauri job list; mark completions and stage notices. Returns thread ids with new notices. */
export async function pollBackgroundJobs(): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  const running = [...watched.values()].filter((job) => !job.done);
  if (!running.length) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  const jobs = await invoke<JobListRow[]>("agent_workspace_job_list");
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const notifiedThreads = new Set<string>();
  for (const watchedJob of running) {
    const row = byId.get(watchedJob.jobId);
    if (!row) continue;
    if (row.status === "running") {
      watchedJob.status = row.status;
      continue;
    }
    watchedJob.status = row.status;
    watchedJob.done = true;
    let detail = "";
    try {
      const hit = await invoke<JobOutputHit>("agent_workspace_job_output", {
        jobId: watchedJob.jobId,
        wait: false,
        timeoutMs: 0,
      });
      const body = [hit.output, hit.stderr]
        .filter((part) => part?.trim())
        .join("\n")
        .trim();
      detail = body ? clipInline(body) : "";
    } catch {
      detail = "";
    }
    const label = watchedJob.description.replace(/\s+/g, " ").slice(0, 120);
    watchedJob.pendingNotice = detail
      ? `background job ${watchedJob.jobId} (shell: ${label}) finished [status: ${watchedJob.status}]. Output:\n${detail}`
      : `background job ${watchedJob.jobId} (shell: ${label}) finished [status: ${watchedJob.status}]. No new output.`;
    notifiedThreads.add(watchedJob.threadId);
  }
  return [...notifiedThreads];
}

function clipInline(text: string, max = 2048): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated; use job_output)`;
}
