use crate::state::{AppNav, AppState};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::clipboard::Clipboard;
use gpui_kit::component::input::{
    Escape as InputEscape, IndentInline, Input, InputEvent, InputState, MoveDown, MoveUp, Textarea,
    TextareaState,
};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::text::TextView;
use gpui_kit::component::{Selectable as _, *};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use gpui_webview::WebView;
use std::collections::HashSet;
use wb_agent::{
    SlashCommand, TurnPhase, apply_slash_completion, begin_user_turn, clear_goal_round_flag,
    continue_turn_reply, create_thread, cycle_permission_mode, dequeue_user_text,
    enqueue_user_text, finish_continue_turn, finish_user_turn, load_providers,
    model_context_window, pending_approvals_for_thread, permission_mode_label,
    prepare_goal_idle_round, prompt_char_count, queued_user_texts, resolve_approval,
    resolve_turn_reply, slash_suggestions,
};
use wb_domain::BUILTIN_MODEL_REF;
use wb_domain::{
    AgentMessage, AgentRole, AgentWorkspace, WEB_AGENT_THREAD_TITLE,
    agent_workspace_title_from_path, create_id, normalize_agent_web_url, now_ms,
};
use wb_host::{cleanup_tool_spill, global_terminals};

pub struct AgentPane {
    state: AppState,
    input: Entity<TextareaState>,
    web_url_input: Entity<InputState>,
    find: Entity<InputState>,
    webview: Option<Entity<WebView>>,
    loaded_web_url: Option<String>,
    busy: bool,
    /// Bumped to cancel the in-flight turn spawn.
    turn_gen: u64,
    status: String,
    prompt_history: Vec<String>,
    history_index: Option<usize>,
    history_draft: String,
    slash_selected: usize,
    slash_dismissed: bool,
    expanded_tools: HashSet<String>,
    show_archived: bool,
    workspace_filter: Option<String>,
    show_terminal: bool,
    term_id: Option<String>,
    _subs: Vec<Subscription>,
}

impl AgentPane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 8)
                .submit_on_enter(true)
                .placeholder("给 Agent 发消息。Enter 发送，Shift+Enter 换行，↑ 历史，/ 斜杠命令")
        });
        let web_url_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("https://… 新建网页会话"));
        let find = cx.new(|cx| InputState::new(window, cx).placeholder("筛选消息…"));
        let mut this = Self {
            state,
            input: input.clone(),
            web_url_input: web_url_input.clone(),
            find: find.clone(),
            webview: None,
            loaded_web_url: None,
            busy: false,
            turn_gen: 0,
            status: String::new(),
            prompt_history: Vec::new(),
            history_index: None,
            history_draft: String::new(),
            slash_selected: 0,
            slash_dismissed: false,
            expanded_tools: HashSet::new(),
            show_archived: false,
            workspace_filter: None,
            show_terminal: false,
            term_id: None,
            _subs: Vec::new(),
        };
        this._subs.push(cx.subscribe_in(
            &input,
            window,
            |this, input, event, window, cx| match event {
                InputEvent::Change => {
                    this.slash_selected = 0;
                    this.slash_dismissed = false;
                    cx.notify();
                }
                InputEvent::PressEnter { shift, secondary } => {
                    if *shift && !*secondary {
                        return;
                    }
                    if this.accept_slash_if_open(window, cx) {
                        return;
                    }
                    let text = input.read(cx).value().to_string();
                    if text.trim().is_empty() {
                        return;
                    }
                    input.update(cx, |input, cx| {
                        input.set_value("", window, cx);
                    });
                    this.send(text, cx);
                }
                _ => {}
            },
        ));
        this._subs
            .push(cx.subscribe_in(&find, window, |_this, _, event, _, cx| {
                if let InputEvent::Change = event {
                    cx.notify();
                }
            }));
        this._subs.push(cx.subscribe_in(
            &web_url_input,
            window,
            |this, input, event, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    let url = input.read(cx).value().to_string();
                    this.create_web_thread(&url, window, cx);
                }
            },
        ));
        this
    }

    pub fn hide_webview(&mut self, cx: &mut Context<Self>) {
        if let Some(wv) = &self.webview {
            wv.update(cx, |v, _| v.hide());
        }
        self.loaded_web_url = None;
    }

    fn ensure_webview(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.webview.is_some() {
            return true;
        }
        match WebView::build(wry::WebViewBuilder::new(), window, cx) {
            Ok(view) => {
                let entity = cx.new(|_cx| view);
                entity.update(cx, |v, _| v.hide());
                self.webview = Some(entity);
                true
            }
            Err(e) => {
                self.status = format!("无法创建网页视图：{e}");
                false
            }
        }
    }

    fn sync_webview(&mut self, url: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(url) = url.filter(|u| !u.is_empty()) else {
            self.hide_webview(cx);
            return;
        };
        if !self.ensure_webview(window, cx) {
            return;
        }
        let Some(wv) = self.webview.clone() else {
            return;
        };
        if self.loaded_web_url.as_deref() != Some(url) {
            wv.update(cx, |v, _| {
                v.load_url(url);
                v.show();
            });
            self.loaded_web_url = Some(url.to_string());
        } else {
            wv.update(cx, |v, _| v.show());
        }
    }

    fn create_web_thread(&mut self, raw: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(url) = normalize_agent_web_url(raw) else {
            self.status = "请输入有效网址（例如 https://example.com）".into();
            cx.notify();
            return;
        };
        if !self.ensure_webview(window, cx) {
            cx.notify();
            return;
        }
        let thread_id = self.state.with_mut(|s| {
            let ws = s
                .repo
                .list_agent_workspaces()
                .into_iter()
                .next()
                .expect("default workspace");
            let mut thread = create_thread(
                &ws.id,
                WEB_AGENT_THREAD_TITLE,
                s.prefs.agent.default_model_ref.as_deref(),
            );
            thread.web_url = Some(url.clone());
            let id = thread.id.clone();
            s.repo.upsert_agent_thread(thread);
            s.active_thread_id = Some(id.clone());
            id
        });
        let _ = thread_id;
        self.web_url_input.update(cx, |i, cx| {
            i.set_value(&url, window, cx);
        });
        self.sync_webview(Some(&url), window, cx);
        self.status.clear();
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn apply_web_url_to_active(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let raw = self.web_url_input.read(cx).value().to_string();
        let Some(url) = normalize_agent_web_url(&raw) else {
            self.status = "网址无效".into();
            cx.notify();
            return;
        };
        let updated = self.state.with_mut(|s| {
            let Some(id) = s.active_thread_id.clone() else {
                return false;
            };
            let Some(mut t) = s.repo.list_agent_threads().into_iter().find(|t| t.id == id) else {
                return false;
            };
            t.web_url = Some(url.clone());
            if t.title == "新会话" || t.title.is_empty() {
                t.title = WEB_AGENT_THREAD_TITLE.into();
            }
            t.updated_at = now_ms();
            s.repo.upsert_agent_thread(t);
            true
        });
        if updated {
            self.sync_webview(Some(&url), window, cx);
            self.status.clear();
            self.state.persist_if_dirty();
        }
        cx.notify();
    }

    fn ensure_thread(&mut self) -> String {
        self.state.with_mut(|s| {
            if let Some(id) = s.active_thread_id.clone() {
                if s.repo.list_agent_threads().iter().any(|t| t.id == id) {
                    return id;
                }
            }
            let ws = s
                .repo
                .list_agent_workspaces()
                .into_iter()
                .next()
                .expect("default workspace");
            let thread =
                create_thread(&ws.id, "新会话", s.prefs.agent.default_model_ref.as_deref());
            let id = thread.id.clone();
            s.repo.upsert_agent_thread(thread);
            s.active_thread_id = Some(id.clone());
            id
        })
    }

    fn send(&mut self, text: String, cx: &mut Context<Self>) {
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        if self.prompt_history.last().map(|s| s.as_str()) != Some(text.as_str()) {
            self.prompt_history.push(text.clone());
        }
        self.history_index = None;
        self.history_draft.clear();

        if text == "/clear" || text.starts_with("/clear ") {
            self.clear_active_thread(cx);
            return;
        }
        if text == "/rename" || text.starts_with("/rename ") {
            let rest = text.trim_start_matches("/rename").trim();
            if rest.is_empty() {
                self.status = "用法：/rename 新标题".into();
            } else {
                self.rename_active_thread(rest, cx);
                self.status = format!(
                    "已重命名为「{}」",
                    rest.chars().take(48).collect::<String>()
                );
            }
            cx.notify();
            return;
        }

        let thread_id = self.ensure_thread();
        if self.busy {
            let n = self
                .state
                .with_mut(|s| enqueue_user_text(&mut s.repo, &thread_id, &text));
            self.state.persist_if_dirty();
            self.status = format!("已排队，前面还有 {} 条", n.saturating_sub(1));
            cx.notify();
            return;
        }
        clear_goal_round_flag();
        let proxy = self.state.with(|s| s.prefs.http_proxy.clone());
        let thread = self.state.with(|s| {
            s.repo
                .list_agent_threads()
                .into_iter()
                .find(|t| t.id == thread_id)
        });
        let Some(thread) = thread else {
            return;
        };

        let pending = self
            .state
            .with_mut(|s| begin_user_turn(&mut s.repo, &thread, &text));
        self.state.persist_if_dirty();

        self.turn_gen = self.turn_gen.wrapping_add(1);
        let expected = self.turn_gen;
        self.busy = true;
        self.status.clear();
        cx.notify();

        let drain_tid = thread_id.clone();
        cx.spawn(async move |this, cx| {
            let still_active = |this: &WeakEntity<AgentPane>, cx: &mut AsyncApp| -> bool {
                this.update(cx, |pane, _| pane.turn_gen == expected && pane.busy)
                    .unwrap_or(false)
            };

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

            if !still_active(&this, cx) {
                return;
            }

            let mut phase = this
                .update(cx, |this, cx| {
                    let phase = this
                        .state
                        .with_mut(|s| finish_user_turn(&mut s.repo, &pending, reply));
                    this.apply_open_view(phase.open_view());
                    this.state.persist_if_dirty();
                    cx.notify();
                    phase
                })
                .ok();

            let mut goal_followups = 0u32;
            loop {
                if !still_active(&this, cx) {
                    return;
                }
                while let Some(TurnPhase::Continue(cont, _)) = phase {
                    if !still_active(&this, cx) {
                        return;
                    }
                    let proxy3 = proxy.clone();
                    let cont2 = (*cont).clone();
                    let reply = cx
                        .background_executor()
                        .spawn(async move {
                            let rt = tokio::runtime::Builder::new_current_thread()
                                .enable_all()
                                .build()
                                .expect("tokio runtime");
                            rt.block_on(continue_turn_reply(&cont2, proxy3.as_deref()))
                        })
                        .await;
                    if !still_active(&this, cx) {
                        return;
                    }
                    phase = this
                        .update(cx, |this, cx| {
                            let next = this
                                .state
                                .with_mut(|s| finish_continue_turn(&mut s.repo, &cont, reply));
                            this.apply_open_view(next.open_view());
                            this.state.persist_if_dirty();
                            cx.notify();
                            next
                        })
                        .ok();
                }

                if goal_followups >= 2 {
                    break;
                }
                let Some(goal_prompt) = prepare_goal_idle_round() else {
                    break;
                };
                goal_followups += 1;
                let pending_goal = match this.update(cx, |this, cx| {
                    let tid = this.ensure_thread();
                    let thread = this.state.with(|s| {
                        s.repo
                            .list_agent_threads()
                            .into_iter()
                            .find(|t| t.id == tid)
                    });
                    let thread = thread?;
                    let pending = this
                        .state
                        .with_mut(|s| begin_user_turn(&mut s.repo, &thread, &goal_prompt));
                    this.state.persist_if_dirty();
                    cx.notify();
                    Some(pending)
                }) {
                    Ok(Some(p)) => p,
                    _ => break,
                };
                let pending2 = pending_goal.clone();
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
                if !still_active(&this, cx) {
                    return;
                }
                phase = this
                    .update(cx, |this, cx| {
                        let next = this
                            .state
                            .with_mut(|s| finish_user_turn(&mut s.repo, &pending_goal, reply));
                        this.apply_open_view(next.open_view());
                        this.state.persist_if_dirty();
                        cx.notify();
                        next
                    })
                    .ok();
            }

            this.update(cx, |this, cx| {
                if this.turn_gen == expected {
                    this.status.clear();
                    this.busy = false;
                    cx.notify();
                    this.drain_queue_for(&drain_tid, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn drain_queue_for(&mut self, thread_id: &str, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let active = self.state.with(|s| s.active_thread_id.clone());
        if active.as_deref() != Some(thread_id) {
            return;
        }
        let next = self
            .state
            .with_mut(|s| dequeue_user_text(&mut s.repo, thread_id));
        if let Some(text) = next {
            self.state.persist_if_dirty();
            self.send(text, cx);
        }
    }

    fn stop_turn(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            return;
        }
        self.turn_gen = self.turn_gen.wrapping_add(1);
        self.busy = false;
        self.status = "已中止当前回合（进行中的模型请求可能仍会完成，但结果会被丢弃）".into();
        cx.notify();
    }

    fn cycle_thread_permission(&mut self, cx: &mut Context<Self>) {
        let tid = self.ensure_thread();
        self.state.with_mut(|s| {
            if let Some(mut t) = s
                .repo
                .list_agent_threads()
                .into_iter()
                .find(|t| t.id == tid)
            {
                t.permission_mode = cycle_permission_mode(t.permission_mode);
                s.repo.upsert_agent_thread(t);
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn available_model_refs() -> Vec<String> {
        let mut refs = vec![BUILTIN_MODEL_REF.to_string()];
        for p in load_providers().providers {
            if p.id.starts_with("builtin") {
                continue;
            }
            if p.models.is_empty() {
                refs.push(format!("{}/default", p.id));
            } else {
                for mid in p.models.keys() {
                    refs.push(format!("{}/{}", p.id, mid));
                }
            }
        }
        refs
    }

    fn cycle_thread_model(&mut self, cx: &mut Context<Self>) {
        let tid = self.ensure_thread();
        let refs = Self::available_model_refs();
        if refs.is_empty() {
            return;
        }
        self.state.with_mut(|s| {
            if let Some(mut t) = s
                .repo
                .list_agent_threads()
                .into_iter()
                .find(|t| t.id == tid)
            {
                let idx = refs.iter().position(|r| r == &t.model_ref).unwrap_or(0);
                t.model_ref = refs[(idx + 1) % refs.len()].clone();
                s.repo.upsert_agent_thread(t);
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn apply_open_view(&mut self, view: Option<&str>) {
        let Some(view) = view else {
            return;
        };
        if let Some(nav) = AppNav::from_view_id(view) {
            self.state.with_mut(|s| s.nav = nav);
        }
    }

    fn decide_approval(&mut self, approval_id: String, approved: bool, cx: &mut Context<Self>) {
        let root = self.state.with(|s| {
            let tid = s.active_thread_id.clone()?;
            let thread = s
                .repo
                .list_agent_threads()
                .into_iter()
                .find(|t| t.id == tid)?;
            s.repo
                .list_agent_workspaces()
                .into_iter()
                .find(|w| w.id == thread.workspace_id)
                .and_then(|w| w.root_path)
        });
        let open_view = self.state.with_mut(|s| {
            resolve_approval(&mut s.repo, &approval_id, approved, root.as_deref())
                .map(|o| o.open_view)
                .unwrap_or_else(|e| {
                    log::warn!("审批失败: {e}");
                    None
                })
        });
        self.apply_open_view(open_view.as_deref());
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn add_workspace(&mut self, cx: &mut Context<Self>) {
        super::prompt_directory(cx, |this, dir, cx| {
            let Some(dir) = dir else {
                return;
            };
            let path = dir.to_string_lossy().to_string();
            let title = agent_workspace_title_from_path(&path);
            let now = now_ms();
            let ws = AgentWorkspace {
                id: create_id(now),
                title,
                root_path: Some(path.clone()),
                created_at: now,
                updated_at: now,
            };
            if let Ok(n) = cleanup_tool_spill(std::path::Path::new(&path)) {
                if n > 0 {
                    log::info!("cleaned {n} old spill files in {path}");
                }
            }
            this.state.with_mut(|s| s.repo.upsert_agent_workspace(ws));
            this.state.persist_if_dirty();
            cx.notify();
        });
    }

    pub fn focus_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.read(cx).focus_handle(cx).focus(window, cx);
        cx.notify();
    }

    fn new_thread(&mut self, cx: &mut Context<Self>) {
        self.stop_turn(cx);
        self.state.with_mut(|s| s.active_thread_id = None);
        let _ = self.ensure_thread();
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn clear_active_thread(&mut self, cx: &mut Context<Self>) {
        self.stop_turn(cx);
        let Some(tid) = self.state.with(|s| s.active_thread_id.clone()) else {
            return;
        };
        self.state.with_mut(|s| s.repo.clear_agent_messages(&tid));
        self.expanded_tools.clear();
        self.status = "已清空当前会话".into();
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn rename_active_thread(&mut self, title: &str, cx: &mut Context<Self>) {
        let title = title.trim();
        if title.is_empty() {
            return;
        }
        let Some(tid) = self.state.with(|s| s.active_thread_id.clone()) else {
            return;
        };
        self.state.with_mut(|s| {
            if let Some(mut t) = s
                .repo
                .list_agent_threads()
                .into_iter()
                .find(|t| t.id == tid)
            {
                t.title = title.chars().take(48).collect();
                t.updated_at = now_ms();
                s.repo.upsert_agent_thread(t);
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn delete_thread(&mut self, id: &str, cx: &mut Context<Self>) {
        if self
            .state
            .with(|s| s.active_thread_id.as_deref() == Some(id))
        {
            self.stop_turn(cx);
        }
        self.state.with_mut(|s| {
            s.repo.delete_agent_thread(id);
            if s.active_thread_id.as_deref() == Some(id) {
                s.active_thread_id = None;
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn select_thread(&mut self, id: String, cx: &mut Context<Self>) {
        if self
            .state
            .with(|s| s.active_thread_id.as_deref() != Some(id.as_str()))
        {
            self.stop_turn(cx);
        }
        self.state.with_mut(|s| s.active_thread_id = Some(id));
        cx.notify();
    }

    fn toggle_pin_thread(&mut self, id: &str, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            if let Some(mut t) = s.repo.list_agent_threads().into_iter().find(|t| t.id == id) {
                t.pinned_at = if t.pinned_at.is_some() {
                    None
                } else {
                    Some(now_ms())
                };
                t.updated_at = now_ms();
                s.repo.upsert_agent_thread(t);
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn toggle_archive_thread(&mut self, id: &str, cx: &mut Context<Self>) {
        self.state.with_mut(|s| {
            if let Some(mut t) = s.repo.list_agent_threads().into_iter().find(|t| t.id == id) {
                t.archived_at = if t.archived_at.is_some() {
                    None
                } else {
                    Some(now_ms())
                };
                t.updated_at = now_ms();
                s.repo.upsert_agent_thread(t);
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn live_slash(&self, cx: &App) -> Vec<&'static SlashCommand> {
        if self.slash_dismissed {
            return Vec::new();
        }
        slash_suggestions(&self.input.read(cx).value())
    }

    fn accept_slash_if_open(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let hits = self.live_slash(cx);
        if hits.is_empty() {
            return false;
        }
        let cmd = hits
            .get(self.slash_selected)
            .or_else(|| hits.first())
            .copied();
        let Some(cmd) = cmd else {
            return false;
        };
        let next = apply_slash_completion(&self.input.read(cx).value(), cmd.invoke);
        let len = next.len();
        self.input.update(cx, |state, cx| {
            state.set_value(&next, window, cx);
            state.set_selected_range(len..len, cx);
        });
        self.slash_selected = 0;
        cx.notify();
        true
    }

    fn navigate_prompt_history(
        &mut self,
        delta: isize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.prompt_history.is_empty() {
            return false;
        }
        let n = self.prompt_history.len();
        if delta < 0 {
            let next_idx = match self.history_index {
                None => {
                    self.history_draft = self.input.read(cx).value().to_string();
                    n.saturating_sub(1)
                }
                Some(idx) => idx.saturating_sub(1),
            };
            self.history_index = Some(next_idx);
            let text = self.prompt_history[next_idx].clone();
            let len = text.len();
            self.input.update(cx, |state, cx| {
                state.set_value(&text, window, cx);
                state.set_selected_range(len..len, cx);
            });
            cx.notify();
            true
        } else if let Some(idx) = self.history_index {
            if idx + 1 < n {
                let next_idx = idx + 1;
                self.history_index = Some(next_idx);
                let text = self.prompt_history[next_idx].clone();
                let len = text.len();
                self.input.update(cx, |state, cx| {
                    state.set_value(&text, window, cx);
                    state.set_selected_range(len..len, cx);
                });
            } else {
                self.history_index = None;
                let text = std::mem::take(&mut self.history_draft);
                let len = text.len();
                self.input.update(cx, |state, cx| {
                    state.set_value(&text, window, cx);
                    state.set_selected_range(len..len, cx);
                });
            }
            cx.notify();
            true
        } else {
            false
        }
    }

    fn composer_on_first_line(&self, cx: &App) -> bool {
        let state = self.input.read(cx);
        let text = state.value();
        let cursor = state.cursor().min(text.len());
        !text[..cursor].contains('\n')
    }

    fn composer_on_last_line(&self, cx: &App) -> bool {
        let state = self.input.read(cx);
        let text = state.value();
        let cursor = state.cursor().min(text.len());
        !text[cursor..].contains('\n')
    }

    fn toggle_tool_expand(&mut self, id: String, cx: &mut Context<Self>) {
        if !self.expanded_tools.insert(id.clone()) {
            self.expanded_tools.remove(&id);
        }
        cx.notify();
    }

    fn open_terminal(&mut self, cx: &mut Context<Self>) {
        let cwd = self.state.with(|s| {
            let tid = s.active_thread_id.clone()?;
            let thread = s
                .repo
                .list_agent_threads()
                .into_iter()
                .find(|t| t.id == tid)?;
            s.repo
                .list_agent_workspaces()
                .into_iter()
                .find(|w| w.id == thread.workspace_id)
                .and_then(|w| w.root_path)
        });
        match global_terminals().open("", cwd.as_deref().map(std::path::Path::new)) {
            Ok(id) => {
                self.term_id = Some(id);
                self.show_terminal = true;
                self.status.clear();
            }
            Err(e) => self.status = format!("无法打开终端：{e}"),
        }
        cx.notify();
    }
}

impl Render for AgentPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.render_chat(window, cx)
    }
}

impl AgentPane {
    #[allow(clippy::large_unopt_stack_frames)]
    fn render_chat(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let (
            threads,
            messages,
            workspaces,
            approvals,
            perm_label,
            model_label,
            active_web_url,
            queued,
            model_ref,
        ) = self.state.with(|s| {
            let tid = s.active_thread_id.clone();
            let messages = tid
                .as_deref()
                .map(|id| s.repo.messages_for_thread(id))
                .unwrap_or_default();
            let approvals = tid
                .as_deref()
                .map(|id| pending_approvals_for_thread(&s.repo, id))
                .unwrap_or_default();
            let thread = tid
                .as_deref()
                .and_then(|id| s.repo.list_agent_threads().into_iter().find(|t| t.id == id));
            let web_url = thread.as_ref().and_then(|t| t.web_url.clone());
            let queued = thread.as_ref().map(queued_user_texts).unwrap_or_default();
            let perm = thread
                .as_ref()
                .map(|t| permission_mode_label(t.permission_mode))
                .unwrap_or("确认");
            let model_ref = thread
                .as_ref()
                .map(|t| t.model_ref.clone())
                .unwrap_or_else(|| BUILTIN_MODEL_REF.to_string());
            let model = model_ref
                .split('/')
                .next_back()
                .unwrap_or(model_ref.as_str())
                .to_string();
            (
                s.repo.list_agent_threads(),
                messages,
                s.repo.list_agent_workspaces(),
                approvals,
                perm,
                model,
                web_url,
                queued,
                model_ref,
            )
        });
        self.sync_webview(active_web_url.as_deref(), window, cx);
        let webview_el = self.webview.clone();
        let has_web = active_web_url.is_some() && webview_el.is_some();
        let entity = cx.weak_entity();
        let active = self.state.with(|s| s.active_thread_id.clone());
        let status = self.status.clone();
        let radius = cx.theme().radius;
        let muted = cx.theme().muted_foreground;
        let accent = cx.theme().accent;
        let secondary = cx.theme().secondary;
        let border = cx.theme().border;
        let danger = cx.theme().danger;

        let approval_rows: Vec<_> = approvals
            .into_iter()
            .map(|a| {
                let id_ok = a.id.clone();
                let id_no = a.id.clone();
                let summary = a.summary.clone();
                let tool = a.tool_name.clone();
                h_flex()
                    .gap_2()
                    .p_2()
                    .rounded(radius)
                    .border_1()
                    .border_color(border)
                    .items_center()
                    .child(
                        v_flex()
                            .flex_1()
                            .gap_0p5()
                            .child(div().text_xs().font_bold().child(format!("审批 · {tool}")))
                            .child(div().text_xs().text_color(muted).child(summary)),
                    )
                    .child(
                        Button::new(SharedString::from(format!("appr-ok-{id_ok}")))
                            .xsmall()
                            .primary()
                            .label("批准")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.decide_approval(id_ok.clone(), true, cx);
                            })),
                    )
                    .child(
                        Button::new(SharedString::from(format!("appr-no-{id_no}")))
                            .xsmall()
                            .ghost()
                            .label("拒绝")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.decide_approval(id_no.clone(), false, cx);
                            })),
                    )
                    .into_any_element()
            })
            .collect();

        let find_q = self.find.read(cx).value().trim().to_lowercase();
        let slash_hits = self.live_slash(cx);
        let ctx_used = prompt_char_count(&messages);
        let ctx_cap = model_context_window(&model_ref).max(1);
        let ctx_pct = ((ctx_used as f32 / ctx_cap as f32) * 100.0).min(999.0);
        let ws_filter = self.workspace_filter.clone();
        let show_archived = self.show_archived;
        let mut threads = threads;
        threads.sort_by(|a, b| match (a.pinned_at, b.pinned_at) {
            (Some(x), Some(y)) => y.cmp(&x),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => b.updated_at.cmp(&a.updated_at),
        });
        let thread_rows: Vec<_> = threads
            .into_iter()
            .filter(|t| show_archived || t.archived_at.is_none())
            .filter(|t| {
                ws_filter
                    .as_ref()
                    .map(|id| &t.workspace_id == id)
                    .unwrap_or(true)
            })
            .map(|t| {
                let id = t.id.clone();
                let selected = active.as_deref() == Some(id.as_str());
                let pinned = t.pinned_at.is_some();
                let archived = t.archived_at.is_some();
                let title = {
                    let mut s = t.title.clone();
                    if pinned {
                        s = format!("[置顶] {s}");
                    }
                    if archived {
                        s = format!("[归档] {s}");
                    }
                    s
                };
                let entity = entity.clone();
                h_flex()
                    .w_full()
                    .items_center()
                    .gap_1()
                    .p_2()
                    .rounded(radius)
                    .when(selected, |d| d.bg(accent))
                    .hover(|d| d.bg(accent.opacity(0.5)))
                    .child(
                        div()
                            .id(SharedString::from(format!("thread-{id}")))
                            .flex_1()
                            .overflow_hidden()
                            .cursor_pointer()
                            .child(title)
                            .on_click({
                                let id = id.clone();
                                let entity = entity.clone();
                                move |_, _, app| {
                                    if let Some(e) = entity.upgrade() {
                                        e.update(app, |this, cx| {
                                            this.select_thread(id.clone(), cx);
                                        });
                                    }
                                }
                            }),
                    )
                    .child(
                        Button::new(SharedString::from(format!("pin-thread-{id}")))
                            .xsmall()
                            .ghost()
                            .label(if pinned { "取消置顶" } else { "置顶" })
                            .on_click({
                                let id = id.clone();
                                let entity = entity.clone();
                                move |_, _, app| {
                                    if let Some(e) = entity.upgrade() {
                                        e.update(app, |this, cx| this.toggle_pin_thread(&id, cx));
                                    }
                                }
                            }),
                    )
                    .child(
                        Button::new(SharedString::from(format!("arch-thread-{id}")))
                            .xsmall()
                            .ghost()
                            .label("归档")
                            .on_click({
                                let id = id.clone();
                                let entity = entity.clone();
                                move |_, _, app| {
                                    if let Some(e) = entity.upgrade() {
                                        e.update(app, |this, cx| {
                                            this.toggle_archive_thread(&id, cx)
                                        });
                                    }
                                }
                            }),
                    )
                    .child(
                        Button::new(SharedString::from(format!("del-thread-{id}")))
                            .xsmall()
                            .ghost()
                            .label("×")
                            .on_click({
                                let id = id.clone();
                                let entity = entity.clone();
                                move |_, _, app| {
                                    if let Some(e) = entity.upgrade() {
                                        e.update(app, |this, cx| this.delete_thread(&id, cx));
                                    }
                                }
                            }),
                    )
                    .into_any_element()
            })
            .collect();

        let visible_messages: Vec<AgentMessage> = messages
            .into_iter()
            .filter(|m| {
                find_q.is_empty()
                    || m.content.to_lowercase().contains(&find_q)
                    || m.tool_name
                        .as_deref()
                        .is_some_and(|n| n.to_lowercase().contains(&find_q))
            })
            .collect();
        let empty_chat = visible_messages.is_empty() && find_q.is_empty();
        let filter_miss = visible_messages.is_empty() && !find_q.is_empty();
        let message_rows: Vec<_> = visible_messages
            .into_iter()
            .map(|m| {
                render_chat_message(
                    &m,
                    &self.expanded_tools,
                    radius,
                    muted,
                    accent,
                    secondary,
                    entity.clone(),
                )
            })
            .collect();

        h_flex()
            .size_full()
            .child(
                v_flex()
                    .w(px(240.))
                    .h_full()
                    .border_r_1()
                    .border_color(border)
                    .p_3()
                    .gap_2()
                    .child(
                        h_flex()
                            .gap_2()
                            .flex_wrap()
                            .child(
                                Button::new("agent-new")
                                    .small()
                                    .primary()
                                    .label("新会话")
                                    .on_click(cx.listener(|this, _, _, cx| this.new_thread(cx))),
                            )
                            .child(
                                Button::new("agent-clear")
                                    .small()
                                    .ghost()
                                    .label("清空")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.clear_active_thread(cx);
                                    })),
                            )
                            .child(
                                Button::new("agent-ws")
                                    .small()
                                    .label("工作区")
                                    .on_click(cx.listener(|this, _, _, cx| this.add_workspace(cx))),
                            )
                            .child(
                                Button::new("agent-perm")
                                    .small()
                                    .ghost()
                                    .label(format!("权限:{perm_label}"))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.cycle_thread_permission(cx)
                                    })),
                            )
                            .child(
                                Button::new("agent-model")
                                    .small()
                                    .ghost()
                                    .label(format!("模型:{model_label}"))
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.cycle_thread_model(cx)),
                                    ),
                            )
                            .child(
                                Button::new("agent-web-new")
                                    .small()
                                    .label("网页会话")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        let url = this.web_url_input.read(cx).value().to_string();
                                        this.create_web_thread(&url, window, cx);
                                    })),
                            ),
                    )
                    .child(
                        h_flex().gap_1().flex_wrap().children(
                            std::iter::once(
                                Button::new("ws-filter-all")
                                    .xsmall()
                                    .ghost()
                                    .label("全部")
                                    .selected(ws_filter.is_none())
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.workspace_filter = None;
                                        cx.notify();
                                    }))
                                    .into_any_element(),
                            )
                            .chain(workspaces.iter().map(|ws| {
                                let id = ws.id.clone();
                                let selected = ws_filter.as_deref() == Some(id.as_str());
                                Button::new(SharedString::from(format!("ws-filter-{id}")))
                                    .xsmall()
                                    .ghost()
                                    .label(ws.title.clone())
                                    .selected(selected)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.workspace_filter = Some(id.clone());
                                        cx.notify();
                                    }))
                                    .into_any_element()
                            })),
                        ),
                    )
                    .child(
                        v_flex()
                            .gap_1()
                            .flex_1()
                            .overflow_y_scrollbar()
                            .children(thread_rows),
                    )
                    .child(
                        Button::new("agent-archived")
                            .xsmall()
                            .ghost()
                            .label(if show_archived {
                                "隐藏归档"
                            } else {
                                "显示归档"
                            })
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.show_archived = !this.show_archived;
                                cx.notify();
                            })),
                    ),
            )
            .child(
                v_flex()
                    .flex_1()
                    .h_full()
                    .p_3()
                    .gap_2()
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(Input::new(&self.web_url_input))
                            .child(
                                Button::new("agent-web-go")
                                    .small()
                                    .primary()
                                    .label(if has_web {
                                        "打开/刷新"
                                    } else {
                                        "打开网页"
                                    })
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        let has = this.state.with(|s| {
                                            s.active_thread_id
                                                .as_ref()
                                                .and_then(|id| {
                                                    s.repo
                                                        .list_agent_threads()
                                                        .into_iter()
                                                        .find(|t| &t.id == id)
                                                })
                                                .and_then(|t| t.web_url)
                                                .is_some()
                                        });
                                        if has {
                                            this.apply_web_url_to_active(window, cx);
                                        } else {
                                            let url =
                                                this.web_url_input.read(cx).value().to_string();
                                            this.create_web_thread(&url, window, cx);
                                        }
                                    })),
                            ),
                    )
                    .when(has_web, |col| {
                        col.child(
                            div()
                                .h(px(280.))
                                .w_full()
                                .rounded(radius)
                                .border_1()
                                .border_color(border)
                                .overflow_hidden()
                                .child(webview_el.expect("webview when has_web")),
                        )
                    })
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(div().flex_1().child(Input::new(&self.find).cleanable(true)))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(muted)
                                    .child(format!("上下文 {ctx_pct:.0}%")),
                            )
                            .child(
                                Button::new("agent-term-toggle")
                                    .xsmall()
                                    .ghost()
                                    .label(if self.show_terminal {
                                        "收起终端"
                                    } else {
                                        "终端"
                                    })
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.show_terminal = !this.show_terminal;
                                        cx.notify();
                                    })),
                            ),
                    )
                    .when(self.show_terminal, |col| {
                        let terms = global_terminals().list();
                        let output = self
                            .term_id
                            .as_deref()
                            .and_then(|id| global_terminals().read(id).ok())
                            .unwrap_or_default();
                        let preview: String = output
                            .lines()
                            .rev()
                            .take(14)
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect::<Vec<_>>()
                            .join("\n");
                        col.child(
                            v_flex()
                                .gap_1()
                                .p_2()
                                .rounded(radius)
                                .border_1()
                                .border_color(border)
                                .max_h(px(180.))
                                .child(
                                    h_flex()
                                        .gap_2()
                                        .child(
                                            Button::new("agent-term-open")
                                                .xsmall()
                                                .primary()
                                                .label("新终端")
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.open_terminal(cx);
                                                })),
                                        )
                                        .children(terms.into_iter().map(|info| {
                                            let id = info.id.clone();
                                            let selected =
                                                self.term_id.as_deref() == Some(id.as_str());
                                            Button::new(SharedString::from(format!("term-{id}")))
                                                .xsmall()
                                                .ghost()
                                                .label(info.shell)
                                                .selected(selected)
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.term_id = Some(id.clone());
                                                    this.show_terminal = true;
                                                    cx.notify();
                                                }))
                                        })),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .font_family("monospace")
                                        .overflow_y_scrollbar()
                                        .max_h(px(120.))
                                        .child(if preview.is_empty() {
                                            "终端输出会显示在这里".into()
                                        } else {
                                            preview
                                        }),
                                ),
                        )
                    })
                    .when(!approval_rows.is_empty(), |col| {
                        col.child(v_flex().gap_2().children(approval_rows))
                    })
                    .child(if empty_chat {
                        v_flex()
                            .flex_1()
                            .gap_2()
                            .justify_center()
                            .items_center()
                            .child(div().text_sm().font_bold().child("开始一段 Agent 对话"))
                            .child(div().text_xs().text_color(muted).child(
                                "Enter 发送 · Shift+Enter 换行 · / 斜杠 · ↑↓ 历史 · Ctrl+N 聚焦",
                            ))
                            .child(
                                h_flex().gap_2().flex_wrap().children(
                                    ["/task_list", "/project_list", "/goal", "/clear"]
                                        .into_iter()
                                        .map(|cmd| {
                                            Button::new(SharedString::from(format!(
                                                "empty-slash-{cmd}"
                                            )))
                                            .small()
                                            .ghost()
                                            .label(cmd)
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.input.update(cx, |i, cx| {
                                                    i.set_value(cmd, window, cx);
                                                });
                                                this.send(cmd.to_string(), cx);
                                            }))
                                        }),
                                ),
                            )
                            .into_any_element()
                    } else if filter_miss {
                        v_flex()
                            .flex_1()
                            .justify_center()
                            .items_center()
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(muted)
                                    .child("没有匹配筛选条件的消息"),
                            )
                            .into_any_element()
                    } else {
                        v_flex()
                            .flex_1()
                            .gap_2()
                            .overflow_y_scrollbar()
                            .children(message_rows)
                            .when(self.busy, |col| {
                                col.child(
                                    div().text_xs().text_color(muted).child("Agent 正在回复…"),
                                )
                            })
                            .into_any_element()
                    })
                    .when(!queued.is_empty(), |col| {
                        col.child(div().text_xs().text_color(muted).child(format!(
                            "队列 {} 条：{}",
                            queued.len(),
                            queued.join(" · ")
                        )))
                    })
                    .when(!status.is_empty(), |col| {
                        col.child(div().text_sm().text_color(danger).child(status))
                    })
                    .when(!slash_hits.is_empty(), |col| {
                        let selected = self.slash_selected;
                        col.child(
                            v_flex()
                                .gap_0p5()
                                .p_2()
                                .rounded(radius)
                                .border_1()
                                .border_color(border)
                                .bg(secondary)
                                .children(slash_hits.iter().enumerate().map(|(i, cmd)| {
                                    let invoke = cmd.invoke;
                                    h_flex()
                                        .id(SharedString::from(format!("slash-hit-{invoke}")))
                                        .gap_2()
                                        .px_2()
                                        .py_1()
                                        .rounded(radius)
                                        .cursor_pointer()
                                        .when(i == selected, |row| row.bg(accent.opacity(0.35)))
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.slash_selected = i;
                                            this.accept_slash_if_open(window, cx);
                                        }))
                                        .child(
                                            div()
                                                .text_xs()
                                                .font_bold()
                                                .child(cmd.invoke.to_string()),
                                        )
                                        .child(
                                            div()
                                                .text_xs()
                                                .text_color(muted)
                                                .child(cmd.hint.to_string()),
                                        )
                                        .into_any_element()
                                })),
                        )
                    })
                    .child(
                        h_flex()
                            .gap_2()
                            .items_end()
                            .capture_action(cx.listener(|this, _: &MoveDown, window, cx| {
                                let hits = this.live_slash(cx);
                                if !hits.is_empty() {
                                    this.slash_selected = (this.slash_selected + 1) % hits.len();
                                    cx.notify();
                                    cx.stop_propagation();
                                } else if this.history_index.is_some()
                                    && this.composer_on_last_line(cx)
                                    && this.navigate_prompt_history(1, window, cx)
                                {
                                    cx.stop_propagation();
                                }
                            }))
                            .capture_action(cx.listener(|this, _: &MoveUp, window, cx| {
                                let hits = this.live_slash(cx);
                                if !hits.is_empty() {
                                    this.slash_selected = this
                                        .slash_selected
                                        .checked_sub(1)
                                        .unwrap_or(hits.len() - 1);
                                    cx.notify();
                                    cx.stop_propagation();
                                } else if this.composer_on_first_line(cx)
                                    && this.navigate_prompt_history(-1, window, cx)
                                {
                                    cx.stop_propagation();
                                }
                            }))
                            .capture_action(cx.listener(|this, _: &IndentInline, window, cx| {
                                if this.accept_slash_if_open(window, cx) {
                                    cx.stop_propagation();
                                }
                            }))
                            .capture_action(cx.listener(|this, _: &InputEscape, _, cx| {
                                if !this.live_slash(cx).is_empty() {
                                    this.slash_dismissed = true;
                                    this.slash_selected = 0;
                                    cx.notify();
                                    cx.stop_propagation();
                                }
                            }))
                            .child(div().flex_1().child(Textarea::new(&self.input)))
                            .child(
                                Button::new("send")
                                    .primary()
                                    .label(if self.busy { "排队" } else { "发送" })
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        if this.accept_slash_if_open(window, cx) {
                                            return;
                                        }
                                        let text = this.input.read(cx).value().to_string();
                                        if !text.trim().is_empty() {
                                            this.input.update(cx, |i, cx| {
                                                i.set_value("", window, cx);
                                            });
                                            this.send(text, cx);
                                        }
                                    })),
                            )
                            .when(self.busy, |row| {
                                row.child(
                                    Button::new("agent-stop").danger().label("中止").on_click(
                                        cx.listener(|this, _, _, cx| {
                                            this.stop_turn(cx);
                                        }),
                                    ),
                                )
                            }),
                    ),
            )
            .into_any_element()
    }
}

fn render_chat_message(
    m: &AgentMessage,
    expanded_tools: &HashSet<String>,
    radius: Pixels,
    muted: Hsla,
    accent: Hsla,
    secondary: Hsla,
    entity: WeakEntity<AgentPane>,
) -> AnyElement {
    let role = match m.role {
        AgentRole::User => "你",
        AgentRole::Assistant => "Agent",
        AgentRole::Tool => m.tool_name.as_deref().unwrap_or("tool"),
        AgentRole::System => "系统",
    };
    let content = m.content.clone();
    let use_md = matches!(m.role, AgentRole::Assistant | AgentRole::System);
    let msg_id = m.id.clone();
    let is_user = matches!(m.role, AgentRole::User);
    let is_tool = matches!(m.role, AgentRole::Tool);
    let expanded = expanded_tools.contains(&msg_id);
    let body = if is_tool && !expanded {
        let preview: String = content.chars().take(80).collect();
        div()
            .text_xs()
            .text_color(muted)
            .child(if content.chars().count() > 80 {
                format!("{preview}…")
            } else {
                preview
            })
            .into_any_element()
    } else if use_md {
        TextView::markdown(SharedString::from(format!("msg-{msg_id}")), content.clone())
            .into_any_element()
    } else {
        div().text_sm().child(content.clone()).into_any_element()
    };
    let copy_id = format!("copy-{msg_id}");
    let header = h_flex()
        .w_full()
        .items_center()
        .gap_2()
        .child(
            div()
                .text_xs()
                .font_bold()
                .text_color(muted)
                .child(role.to_string()),
        )
        .when(is_tool, |row| {
            let tid = msg_id.clone();
            let entity = entity.clone();
            row.child(
                Button::new(SharedString::from(format!("tool-exp-{tid}")))
                    .xsmall()
                    .ghost()
                    .label(if expanded { "收起" } else { "展开" })
                    .on_click(move |_, _, app| {
                        if let Some(e) = entity.upgrade() {
                            e.update(app, |this, cx| this.toggle_tool_expand(tid.clone(), cx));
                        }
                    }),
            )
        })
        .child(
            Clipboard::new(copy_id)
                .value(content.clone())
                .tooltip("复制消息"),
        );
    h_flex()
        .w_full()
        .when(is_user, |row| row.justify_end())
        .child(
            v_flex()
                .gap_1()
                .p_2()
                .rounded(radius)
                .max_w(relative(0.86))
                .bg(if is_user {
                    accent.opacity(0.18)
                } else {
                    secondary
                })
                .child(header)
                .child(body),
        )
        .into_any_element()
}
