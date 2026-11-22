//! Deliver due timed tasks into an Agent thread (async model turn).

use crate::state::AppState;
use gpui_kit::*;
use wb_agent::{begin_user_turn, create_thread, finish_user_turn, resolve_turn_reply};
use wb_domain::{
    NotificationKind, TimedRunOutcome, TimedRunRecord, TimedTask, build_timed_task_prompt,
    create_id, mark_timed_task_ran, now_ms,
};

/// Mark ran + notify, then enqueue an async Agent turn with the timed prompt.
pub fn fire_timed_task<T: 'static>(
    state: &AppState,
    task: &TimedTask,
    cx: &mut Context<T>,
    on_done: impl FnOnce(&mut T, &mut Context<T>) + 'static,
) {
    let prompt = build_timed_task_prompt(task);
    let command_preview = if task.command.trim().is_empty() {
        "（无指令，仅通知）".to_string()
    } else {
        task.command.clone()
    };

    let now = now_ms();
    let updated = mark_timed_task_ran(task, now);
    state.with_mut(|s| {
        s.repo.upsert_timed_task(updated);
        s.repo.append_timed_run(TimedRunRecord {
            id: create_id(now),
            task_id: task.id.clone(),
            ran_at: now,
            status: TimedRunOutcome::Executed,
        });
    });
    state.push_notification(
        NotificationKind::System,
        &format!("定时任务：{}", task.title),
        &command_preview,
        Some(&task.id),
    );
    state.persist_if_dirty();

    if task.command.trim().is_empty() {
        return;
    }

    let proxy = state.with(|s| s.prefs.http_proxy.clone());
    let thread = state.with_mut(|s| {
        let ws = s
            .repo
            .list_agent_workspaces()
            .into_iter()
            .next()
            .expect("default workspace");
        let title = format!("定时：{}", task.title);
        // Reuse an open thread with the same title if present; else create.
        if let Some(existing) = s
            .repo
            .list_agent_threads()
            .into_iter()
            .find(|t| t.title == title && t.archived_at.is_none())
        {
            s.active_thread_id = Some(existing.id.clone());
            existing
        } else {
            let thread = create_thread(&ws.id, &title, s.prefs.agent.default_model_ref.as_deref());
            let id = thread.id.clone();
            s.repo.upsert_agent_thread(thread.clone());
            s.active_thread_id = Some(id);
            thread
        }
    });

    let pending = state.with_mut(|s| begin_user_turn(&mut s.repo, &thread, &prompt));
    state.persist_if_dirty();

    let state2 = state.clone();
    cx.spawn(async move |this, cx| {
        let pending2 = pending.clone();
        let proxy2 = proxy.clone();
        let reply = cx
            .background_executor()
            .spawn(async move {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("tokio runtime");
                rt.block_on(resolve_turn_reply(&pending2, proxy2.as_deref()))
            })
            .await;

        this.update(cx, move |this, cx| {
            state2.with_mut(|s| {
                finish_user_turn(&mut s.repo, &pending, reply);
            });
            state2.persist_if_dirty();
            on_done(this, cx);
        })
        .ok();
    })
    .detach();
}

/// Advance schedule without delivering to Agent.
pub fn skip_timed_task(state: &AppState, task: &TimedTask) {
    let now = now_ms();
    let updated = mark_timed_task_ran(task, now);
    state.with_mut(|s| {
        s.repo.upsert_timed_task(updated);
        s.repo.append_timed_run(TimedRunRecord {
            id: create_id(now),
            task_id: task.id.clone(),
            ran_at: now,
            status: TimedRunOutcome::Skipped,
        });
    });
    state.push_notification(
        NotificationKind::System,
        &format!("已跳过：{}", task.title),
        "定时任务已跳过本次",
        Some(&task.id),
    );
    state.persist_if_dirty();
}
