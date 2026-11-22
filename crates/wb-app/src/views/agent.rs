use crate::state::{AppNav, AppState};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::clipboard::Clipboard;
use gpui_kit::component::input::{
    Escape as InputEscape, IndentInline, Input, InputEvent, InputState, MoveDown, MoveRight,
    MoveUp, Textarea, TextareaState,
};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::text::TextView;
use gpui_kit::component::{Selectable as _, *};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use gpui_webview::WebView;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use wb_agent::{
    ContinueTurn, SlashCommand, StreamEvent, TurnPhase, answer_user_question,
    apply_slash_completion, begin_user_turn, clear_goal_round_flag, compact_thread_history,
    continue_turn_reply_streaming, create_thread, cycle_permission_mode, dequeue_user_text,
    enqueue_user_text, finish_continue_turn_with_stage, finish_user_turn_with_stage,
    load_providers, model_context_window, pending_approvals_for_thread, permission_mode_label,
    prepare_goal_idle_round, prompt_char_count, queued_user_texts, remove_queued_user_text,
    resolve_approval, resolve_turn_reply_streaming, slash_suggestions,
};
use wb_domain::{
    AgentMessage, AgentRole, AgentWorkspace, WEB_AGENT_THREAD_TITLE,
    agent_workspace_title_from_path, create_id, format_chat_day_label, format_local_clock,
    format_local_day, normalize_agent_web_url, now_ms,
};
use wb_domain::{BUILTIN_MODEL_REF, BUILTIN_PROVIDER_ID};
use wb_host::{cleanup_tool_spill, global_terminals};

/// `@path` tokens in the draft, in order of appearance, deduplicated.
fn draft_file_refs(draft: &str) -> Vec<String> {
    crate::composer_text::draft_file_refs(draft)
}

/// `provider/model` → `model` for compact chips and menus.
fn model_label_of(model_ref: &str) -> String {
    crate::composer_text::model_label_of(model_ref)
}

/// Quick filters over the chat transcript.
#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum MsgFilter {
    #[default]
    All,
    User,
    Tools,
    Errors,
}

/// Whether a message is a failed tool call.
///
/// A failure is reported as a tool message whose body starts with something
/// other than "已"; the keywords are a second signal. The role check must
/// cover every keyword, or a user sentence mentioning "错误" would be listed
/// under errors.
fn is_error_message(m: &AgentMessage) -> bool {
    m.is_tool_error()
}

fn apply_stream_event(event: StreamEvent, draft: &Arc<Mutex<String>>, status: &Arc<Mutex<String>>) {
    match event {
        StreamEvent::Text(piece) => {
            if let Ok(mut d) = draft.lock() {
                d.push_str(&piece);
            }
            if let Ok(mut s) = status.lock() {
                s.clear();
            }
        }
        StreamEvent::Tool { name } => {
            if let Ok(mut s) = status.lock() {
                *s = format!("调用 {name}…");
            }
        }
        StreamEvent::Stage { label } => {
            if let Ok(mut s) = status.lock() {
                *s = label;
            }
        }
    }
}

pub struct AgentPane {
    state: AppState,
    input: Entity<TextareaState>,
    web_url_input: Entity<InputState>,
    ask_input: Entity<InputState>,
    find: Entity<InputState>,
    /// Filters the thread list by title.
    thread_query: Entity<InputState>,
    /// Quick filter over the message list (tools / errors / user only).
    msg_filter: MsgFilter,
    /// Show only pinned threads in the list.
    pinned_only: bool,
    webview: Option<Entity<WebView>>,
    loaded_web_url: Option<String>,
    busy: bool,
    /// Bumped to cancel the in-flight turn spawn.
    turn_gen: u64,
    /// Live assistant text while the model streams (plain text, not markdown).
    stream_draft: Arc<Mutex<String>>,
    /// Live status line above the draft (tool name, stage, etc.).
    stream_status: Arc<Mutex<String>>,
    /// Flipped by [`Self::stop_turn`] so the HTTP read loop can exit.
    cancel_flag: Arc<AtomicBool>,
    /// Message text to load into the composer on next render.
    pending_edit: Option<String>,
    /// Text to insert at the caret on next render (keeps the cursor position).
    pending_insert: Option<String>,
    /// Whether the session todo list is expanded under the chat header.
    show_todos: bool,
    /// Cached `@` file suggestions for the current token.
    mention_cache: Vec<String>,
    mention_cache_key: Option<String>,
    mention_selected: usize,
    mention_dismissed: bool,
    /// Show the draft as rendered Markdown above the input.
    composer_preview: bool,
    composer_preview_scroll: ScrollHandle,
    /// Per-thread unsent composer text, so switching threads does not mix drafts.
    drafts: std::collections::HashMap<String, String>,
    /// A file drag is hovering the composer.
    drag_hover: bool,
    /// `(workspace root, branch)` cache so rendering never shells out to git.
    branch_cache: Option<(String, String)>,
    /// Ask approvals that already have an auto-answer timer running.
    ask_timers: HashSet<String>,
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
    chat_scroll: ScrollHandle,
    /// Keep the chat pinned to the newest message until the reader scrolls up.
    chat_follow: bool,
    ghost_suffix: Option<String>,
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
        let thread_query = cx.new(|cx| InputState::new(window, cx).placeholder("搜索会话…"));
        let ask_input = cx.new(|cx| InputState::new(window, cx).placeholder("回答 Agent 的问题…"));
        let state_seed = state.with(|s| s.prefs.agent.prompt_history.clone());
        let mut this = Self {
            state,
            input: input.clone(),
            web_url_input: web_url_input.clone(),
            ask_input: ask_input.clone(),
            find: find.clone(),
            thread_query: thread_query.clone(),
            msg_filter: MsgFilter::All,
            pinned_only: false,
            webview: None,
            loaded_web_url: None,
            busy: false,
            turn_gen: 0,
            stream_draft: Arc::new(Mutex::new(String::new())),
            stream_status: Arc::new(Mutex::new(String::new())),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            pending_edit: None,
            pending_insert: None,
            show_todos: false,
            mention_cache: Vec::new(),
            mention_cache_key: None,
            mention_selected: 0,
            mention_dismissed: false,
            composer_preview: false,
            composer_preview_scroll: ScrollHandle::new(),
            drafts: std::collections::HashMap::new(),
            drag_hover: false,
            branch_cache: None,
            ask_timers: HashSet::new(),
            status: String::new(),
            prompt_history: state_seed,
            history_index: None,
            history_draft: String::new(),
            slash_selected: 0,
            slash_dismissed: false,
            expanded_tools: HashSet::new(),
            show_archived: false,
            workspace_filter: None,
            show_terminal: false,
            term_id: None,
            chat_scroll: ScrollHandle::new(),
            chat_follow: true,
            ghost_suffix: None,
            _subs: Vec::new(),
        };
        this._subs.push(cx.subscribe_in(
            &input,
            window,
            |this, input, event, window, cx| match event {
                InputEvent::Change => {
                    this.slash_selected = 0;
                    this.slash_dismissed = false;
                    this.mention_dismissed = false;
                    this.mention_selected = 0;
                    this.recompute_ghost(cx);
                    // Keep the live preview pinned to the newest line.
                    if this.composer_preview {
                        let handle = this.composer_preview_scroll.clone();
                        cx.spawn(async move |_this, cx| {
                            cx.background_executor()
                                .timer(Duration::from_millis(16))
                                .await;
                            let max = handle.max_offset();
                            handle.set_offset(point(px(0.), -max.y.abs()));
                        })
                        .detach();
                    }
                    cx.notify();
                }
                InputEvent::PressEnter { shift, secondary } => {
                    if *shift && !*secondary {
                        return;
                    }
                    // Slash suggestion and @-mention both claim Enter first.
                    if this.accept_slash_if_open(window, cx) {
                        return;
                    }
                    let mentions = this.live_file_mentions(cx);
                    if let Some(pick) = mentions.get(this.mention_selected).cloned() {
                        if this.accept_file_mention(&pick, window, cx) {
                            return;
                        }
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
        this._subs.push(
            cx.subscribe_in(&thread_query, window, |_this, _, event, _, cx| {
                if let InputEvent::Change = event {
                    cx.notify();
                }
            }),
        );
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
        this._subs.push(
            cx.subscribe_in(&ask_input, window, |this, input, event, window, cx| {
                if let InputEvent::PressEnter { shift, .. } = event {
                    if *shift {
                        return;
                    }
                    let answer = input.read(cx).value().to_string();
                    if answer.trim().is_empty() {
                        return;
                    }
                    input.update(cx, |input, cx| {
                        input.set_value("", window, cx);
                    });
                    this.submit_ask_answer(answer, cx);
                }
            }),
        );
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
        if text == "/clear" || text.starts_with("/clear ") {
            self.clear_active_thread(cx);
            return;
        }
        if text == "/retry" {
            self.retry_last_user(cx);
            return;
        }
        if text == "/compact" || text.starts_with("/compact ") {
            self.compact_history(cx);
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
        if self.prompt_history.last().map(|s| s.as_str()) != Some(text.as_str()) {
            self.prompt_history.push(text.clone());
            if self.prompt_history.len() > 200 {
                let drop = self.prompt_history.len() - 200;
                self.prompt_history.drain(..drop);
            }
            let recent = self.prompt_history.clone();
            self.state
                .with_mut(|s| s.prefs.agent.prompt_history = recent);
            self.state.persist_prefs();
        }
        self.history_index = None;
        self.history_draft.clear();
        self.ghost_suffix = None;

        let thread_id = self.ensure_thread();
        // Very long pastes are spilled to a file so the prompt (and the model
        // window) keeps only a reference plus a preview.
        let (text, spill_note) = if text.chars().count() > 4_000 {
            match self.workspace_root() {
                Some(root) => {
                    let spilled =
                        wb_host::maybe_spill(Some(std::path::Path::new(&root)), "paste", text);
                    if spilled.contains(".wb") && spilled.contains("spill") {
                        (spilled, true)
                    } else {
                        (spilled, false)
                    }
                }
                None => (text, false),
            }
        } else {
            (text, false)
        };
        if spill_note {
            self.status = "长文本已写入 .wb/spill，消息里保留摘要".into();
        }
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
        // Keep the prompt inside the model window: fold old turns before sending.
        let (ctx_chars, ctx_model) = self.state.with(|s| {
            let msgs = s.repo.messages_for_thread(&thread_id);
            let model = s
                .repo
                .list_agent_threads()
                .into_iter()
                .find(|t| t.id == thread_id)
                .map(|t| t.model_ref)
                .unwrap_or_else(|| BUILTIN_MODEL_REF.to_string());
            (prompt_char_count(&msgs), model)
        });
        let cap = model_context_window(&ctx_model).max(1) as usize;
        if ctx_chars * 100 >= cap * 85 {
            let removed = self
                .state
                .with_mut(|s| compact_thread_history(&mut s.repo, &thread_id, 8));
            if removed > 0 {
                self.state.persist_if_dirty();
                self.status = format!("上下文接近上限，已自动折叠较早的 {removed} 条消息");
            }
        }
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
        self.cancel_flag.store(false, Ordering::Relaxed);
        if let Ok(mut draft) = self.stream_draft.lock() {
            draft.clear();
        }
        if let Ok(mut stage) = self.stream_status.lock() {
            stage.clear();
        }
        self.scroll_chat_to_bottom(cx);
        cx.notify();
        self.spawn_draft_poll(expected, cx);

        let drain_tid = thread_id.clone();
        let draft_buf = self.stream_draft.clone();
        let status_buf = self.stream_status.clone();
        let cancel_flag = self.cancel_flag.clone();
        cx.spawn(async move |this, cx| {
            let still_active = |this: &WeakEntity<AgentPane>, cx: &mut AsyncApp| -> bool {
                this.update(cx, |pane, _| pane.turn_gen == expected && pane.busy)
                    .unwrap_or(false)
            };
            let clear_draft = |draft: &Arc<Mutex<String>>, status: &Arc<Mutex<String>>| {
                if let Ok(mut d) = draft.lock() {
                    d.clear();
                }
                if let Ok(mut s) = status.lock() {
                    s.clear();
                }
            };

            let pending2 = pending.clone();
            let proxy2 = proxy.clone();
            let draft2 = draft_buf.clone();
            let status2 = status_buf.clone();
            let cancel2 = cancel_flag.clone();
            let reply = cx
                .background_executor()
                .spawn(async move {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .expect("tokio runtime");
                    rt.block_on(resolve_turn_reply_streaming(
                        &pending2,
                        proxy2.as_deref(),
                        |event| apply_stream_event(event, &draft2, &status2),
                        Some(&cancel2),
                    ))
                })
                .await;

            if !still_active(&this, cx) {
                return;
            }

            let mut phase = this
                .update(cx, |this, cx| {
                    clear_draft(&this.stream_draft, &this.stream_status);
                    let stage = this.stream_status.clone();
                    let on_stage = move |label: &str| {
                        if let Ok(mut s) = stage.lock() {
                            s.clear();
                            s.push_str(label);
                        }
                    };
                    let phase = this.state.with_mut(|s| {
                        finish_user_turn_with_stage(&mut s.repo, &pending, reply, on_stage)
                    });
                    this.apply_open_view(phase.open_view());
                    this.state.persist_if_dirty();
                    this.scroll_chat_to_bottom(cx);
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
                    clear_draft(&draft_buf, &status_buf);
                    let proxy3 = proxy.clone();
                    let cont2 = (*cont).clone();
                    let draft3 = draft_buf.clone();
                    let status3 = status_buf.clone();
                    let cancel3 = cancel_flag.clone();
                    let reply = cx
                        .background_executor()
                        .spawn(async move {
                            let rt = tokio::runtime::Builder::new_current_thread()
                                .enable_all()
                                .build()
                                .expect("tokio runtime");
                            rt.block_on(continue_turn_reply_streaming(
                                &cont2,
                                proxy3.as_deref(),
                                |event| apply_stream_event(event, &draft3, &status3),
                                Some(&cancel3),
                            ))
                        })
                        .await;
                    if !still_active(&this, cx) {
                        return;
                    }
                    phase = this
                        .update(cx, |this, cx| {
                            clear_draft(&this.stream_draft, &this.stream_status);
                            let stage = this.stream_status.clone();
                            let on_stage = move |label: &str| {
                                if let Ok(mut s) = stage.lock() {
                                    s.clear();
                                    s.push_str(label);
                                }
                            };
                            let next = this.state.with_mut(|s| {
                                finish_continue_turn_with_stage(&mut s.repo, &cont, reply, on_stage)
                            });
                            this.apply_open_view(next.open_view());
                            this.state.persist_if_dirty();
                            this.scroll_chat_to_bottom(cx);
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
                clear_draft(&draft_buf, &status_buf);
                let pending2 = pending_goal.clone();
                let proxy2 = proxy.clone();
                let draft2 = draft_buf.clone();
                let status2 = status_buf.clone();
                let cancel2 = cancel_flag.clone();
                let reply = cx
                    .background_executor()
                    .spawn(async move {
                        let rt = tokio::runtime::Builder::new_current_thread()
                            .enable_all()
                            .build()
                            .expect("tokio runtime");
                        rt.block_on(resolve_turn_reply_streaming(
                            &pending2,
                            proxy2.as_deref(),
                            |event| apply_stream_event(event, &draft2, &status2),
                            Some(&cancel2),
                        ))
                    })
                    .await;
                if !still_active(&this, cx) {
                    return;
                }
                phase = this
                    .update(cx, |this, cx| {
                        clear_draft(&this.stream_draft, &this.stream_status);
                        let stage = this.stream_status.clone();
                        let on_stage = move |label: &str| {
                            if let Ok(mut s) = stage.lock() {
                                s.clear();
                                s.push_str(label);
                            }
                        };
                        let next = this.state.with_mut(|s| {
                            finish_user_turn_with_stage(&mut s.repo, &pending_goal, reply, on_stage)
                        });
                        this.apply_open_view(next.open_view());
                        this.state.persist_if_dirty();
                        this.scroll_chat_to_bottom(cx);
                        cx.notify();
                        next
                    })
                    .ok();
            }

            this.update(cx, |this, cx| {
                if this.turn_gen == expected {
                    clear_draft(&this.stream_draft, &this.stream_status);
                    this.status.clear();
                    this.busy = false;
                    this.scroll_chat_to_bottom(cx);
                    cx.notify();
                    this.drain_queue_for(&drain_tid, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn spawn_draft_poll(&self, expected: u64, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(120))
                    .await;
                let cont = this
                    .update(cx, |pane, cx| {
                        if pane.turn_gen != expected || !pane.busy {
                            return false;
                        }
                        // Streaming text grows the draft; follow unless the reader scrolled up.
                        if pane.chat_follow {
                            pane.scroll_chat_to_bottom(cx);
                        }
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !cont {
                    break;
                }
            }
        })
        .detach();
    }

    fn stream_draft_text(&self) -> String {
        self.stream_draft
            .lock()
            .map(|d| d.clone())
            .unwrap_or_default()
    }

    fn stream_status_text(&self) -> String {
        self.stream_status
            .lock()
            .map(|d| d.clone())
            .unwrap_or_default()
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
        self.cancel_flag.store(true, Ordering::Relaxed);

        // Keep what the model already produced instead of throwing it away.
        let partial = self
            .stream_draft
            .lock()
            .map(|d| d.trim().to_string())
            .unwrap_or_default();
        if !partial.is_empty() {
            let tid = self.ensure_thread();
            let msg = AgentMessage {
                id: create_id(now_ms()),
                thread_id: tid,
                role: AgentRole::Assistant,
                content: format!("{partial}\n\n（已中止）"),
                tool_name: None,
                tool_call_id: None,
                tool_calls_json: None,
                duration_ms: None,
                created_at: now_ms(),
            };
            self.state.with_mut(|s| s.repo.upsert_agent_message(msg));
            self.state.persist_if_dirty();
        }
        if let Ok(mut draft) = self.stream_draft.lock() {
            draft.clear();
        }
        if let Ok(mut stage) = self.stream_status.lock() {
            stage.clear();
        }
        self.status = if partial.is_empty() {
            "已中止当前回合".into()
        } else {
            "已中止当前回合，保留已生成的内容".into()
        };
        cx.notify();
    }

    fn retry_last_user(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            self.status = "请先停止当前回合再重试".into();
            cx.notify();
            return;
        }
        let Some(tid) = self.state.with(|s| s.active_thread_id.clone()) else {
            self.status = "没有可重试的用户消息".into();
            cx.notify();
            return;
        };
        let last = self.state.with(|s| {
            s.repo
                .messages_for_thread(&tid)
                .into_iter()
                .rev()
                .find(|m| m.role == AgentRole::User)
        });
        let Some(last) = last else {
            self.status = "没有可重试的用户消息".into();
            cx.notify();
            return;
        };
        self.resend_message(&last.id, cx);
    }

    fn edit_message(&mut self, msg_id: &str, cx: &mut Context<Self>) {
        let content = self.state.with(|s| {
            s.repo
                .list_agent_messages()
                .into_iter()
                .find(|m| m.id == msg_id)
                .map(|m| m.content)
        });
        if let Some(content) = content {
            self.pending_edit = Some(content);
            cx.notify();
        }
    }

    fn start_continue_turn(&mut self, cont: ContinueTurn, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.turn_gen = self.turn_gen.wrapping_add(1);
        let expected = self.turn_gen;
        self.cancel_flag.store(false, Ordering::Relaxed);
        self.busy = true;
        self.status.clear();
        if let Ok(mut draft) = self.stream_draft.lock() {
            draft.clear();
        }
        if let Ok(mut stage) = self.stream_status.lock() {
            stage.clear();
        }
        cx.notify();
        self.spawn_draft_poll(expected, cx);

        let proxy = self.state.with(|s| s.prefs.http_proxy.clone());
        let draft_buf = self.stream_draft.clone();
        let status_buf = self.stream_status.clone();
        let cancel_flag = self.cancel_flag.clone();
        cx.spawn(async move |this, cx| {
            let still_active = |this: &WeakEntity<AgentPane>, cx: &mut AsyncApp| -> bool {
                this.update(cx, |pane, _| pane.turn_gen == expected && pane.busy)
                    .unwrap_or(false)
            };
            let clear_draft = |draft: &Arc<Mutex<String>>, status: &Arc<Mutex<String>>| {
                if let Ok(mut d) = draft.lock() {
                    d.clear();
                }
                if let Ok(mut s) = status.lock() {
                    s.clear();
                }
            };

            let mut cont_opt: Option<ContinueTurn> = Some(cont);

            while let Some(cont) = cont_opt {
                if !still_active(&this, cx) {
                    return;
                }
                clear_draft(&draft_buf, &status_buf);
                let proxy3 = proxy.clone();
                let cont2 = cont.clone();
                let draft3 = draft_buf.clone();
                let status3 = status_buf.clone();
                let cancel3 = cancel_flag.clone();
                let reply = cx
                    .background_executor()
                    .spawn(async move {
                        let rt = tokio::runtime::Builder::new_current_thread()
                            .enable_all()
                            .build()
                            .expect("tokio runtime");
                        rt.block_on(continue_turn_reply_streaming(
                            &cont2,
                            proxy3.as_deref(),
                            |event| apply_stream_event(event, &draft3, &status3),
                            Some(&cancel3),
                        ))
                    })
                    .await;
                if !still_active(&this, cx) {
                    return;
                }
                cont_opt = this
                    .update(cx, |this, cx| {
                        clear_draft(&this.stream_draft, &this.stream_status);
                        let stage = this.stream_status.clone();
                        let on_stage = move |label: &str| {
                            if let Ok(mut s) = stage.lock() {
                                s.clear();
                                s.push_str(label);
                            }
                        };
                        let next = this.state.with_mut(|s| {
                            finish_continue_turn_with_stage(&mut s.repo, &cont, reply, on_stage)
                        });
                        this.apply_open_view(next.open_view());
                        this.state.persist_if_dirty();
                        this.scroll_chat_to_bottom(cx);
                        cx.notify();
                        match next {
                            TurnPhase::Continue(c, _) => Some(*c),
                            TurnPhase::Done(_) => None,
                        }
                    })
                    .ok()
                    .flatten();
            }

            this.update(cx, |this, cx| {
                if this.turn_gen == expected {
                    clear_draft(&this.stream_draft, &this.stream_status);
                    this.status.clear();
                    this.busy = false;
                    this.scroll_chat_to_bottom(cx);
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Auto-answer `ask_user_question` approvals that carry `mode: timed`.
    fn spawn_ask_timers(&mut self, approvals: &[wb_domain::AgentApproval], cx: &mut Context<Self>) {
        for a in approvals {
            if a.tool_name != "ask_user_question" || self.ask_timers.contains(&a.id) {
                continue;
            }
            let Ok(args) = serde_json::from_str::<serde_json::Value>(&a.args_json) else {
                continue;
            };
            let timed = args
                .get("mode")
                .and_then(|v| v.as_str())
                .is_some_and(|m| m.eq_ignore_ascii_case("timed"));
            if !timed {
                continue;
            }
            let secs = args
                .get("timeout")
                .or_else(|| args.get("seconds"))
                .and_then(|v| v.as_u64())
                .unwrap_or(60)
                .clamp(5, 600);
            let id = a.id.clone();
            self.ask_timers.insert(id.clone());
            cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(Duration::from_secs(secs))
                    .await;
                this.update(cx, |pane, cx| pane.auto_answer_ask(&id, cx))
                    .ok();
            })
            .detach();
        }
    }

    fn auto_answer_ask(&mut self, approval_id: &str, cx: &mut Context<Self>) {
        self.ask_timers.remove(approval_id);
        let still_pending = self.state.with(|s| {
            pending_approvals_for_thread(&s.repo, s.active_thread_id.as_deref().unwrap_or_default())
                .iter()
                .any(|a| a.id == approval_id)
        });
        if !still_pending {
            return;
        }
        self.submit_ask_answer("（超时未回复，请按合理默认继续）".into(), cx);
    }

    /// Move a queued entry back into the composer so the user can rework it.
    fn take_queued_into_input(
        &mut self,
        index: usize,
        thread_id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let texts = self.state.with(|s| {
            s.repo
                .list_agent_threads()
                .into_iter()
                .find(|t| t.id == thread_id)
                .map(|t| queued_user_texts(&t))
                .unwrap_or_default()
        });
        let Some(text) = texts.get(index).cloned() else {
            return;
        };
        self.state
            .with_mut(|s| remove_queued_user_text(&mut s.repo, &thread_id, index));
        self.state.persist_if_dirty();
        self.input.update(cx, |input, cx| {
            input.set_value(text, window, cx);
        });
        self.status = "已取回队列消息，编辑后再发送".into();
        cx.notify();
    }

    fn remove_queued(&mut self, index: usize, thread_id: String, cx: &mut Context<Self>) {
        let left = self
            .state
            .with_mut(|s| remove_queued_user_text(&mut s.repo, &thread_id, index));
        self.state.persist_if_dirty();
        self.status = if left == 0 {
            "队列已清空".into()
        } else {
            format!("已移除，队列还剩 {left} 条")
        };
        cx.notify();
    }

    fn compact_history(&mut self, cx: &mut Context<Self>) {
        let Some(tid) = self.state.with(|s| s.active_thread_id.clone()) else {
            self.status = "没有可压缩的会话".into();
            cx.notify();
            return;
        };
        if self.busy {
            self.status = "请先等当前回合结束再压缩".into();
            cx.notify();
            return;
        }
        let keep = 6;
        let removed = self
            .state
            .with_mut(|s| compact_thread_history(&mut s.repo, &tid, keep));
        self.state.persist_if_dirty();
        self.status = if removed == 0 {
            "历史已经很短，无需压缩".into()
        } else {
            format!("已把较早的 {removed} 条消息折叠成摘要，保留最近 {keep} 条")
        };
        self.scroll_chat_to_bottom(cx);
        cx.notify();
    }

    /// Re-run the turn from an assistant message: drop it and everything after it,
    /// then resend the most recent user message.
    fn regenerate_from(&mut self, assistant_id: String, cx: &mut Context<Self>) {
        if self.busy {
            self.status = "请先停止当前回合再重新生成".into();
            cx.notify();
            return;
        }
        let target = self.state.with(|s| {
            s.repo
                .list_agent_messages()
                .into_iter()
                .find(|m| m.id == assistant_id)
        });
        let Some(target) = target else {
            return;
        };
        let tid = target.thread_id.clone();
        let messages = self.state.with(|s| s.repo.messages_for_thread(&tid));
        let Some(user) = messages
            .iter()
            .rfind(|m| m.role == AgentRole::User && m.created_at <= target.created_at)
            .cloned()
        else {
            self.status = "找不到对应的用户消息".into();
            cx.notify();
            return;
        };
        self.state
            .with_mut(|s| s.repo.truncate_agent_messages_at(&tid, user.created_at));
        self.state.persist_if_dirty();
        cx.notify();
        self.send(user.content, cx);
    }

    fn submit_ask_answer(&mut self, answer: String, cx: &mut Context<Self>) {
        let Some(tid) = self.state.with(|s| s.active_thread_id.clone()) else {
            return;
        };
        let ask = self.state.with(|s| {
            pending_approvals_for_thread(&s.repo, &tid)
                .into_iter()
                .find(|a| a.tool_name == "ask_user_question")
        });
        let Some(ask) = ask else {
            self.status = "没有待回答的提问".into();
            cx.notify();
            return;
        };
        let root = self.state.with(|s| {
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
        let phase = self
            .state
            .with_mut(|s| answer_user_question(&mut s.repo, &ask.id, &answer, root.as_deref()));
        match phase {
            Ok(p) => {
                self.state.persist_if_dirty();
                if let TurnPhase::Continue(cont, _) = p {
                    self.start_continue_turn(*cont, cx);
                }
                cx.notify();
            }
            Err(e) => {
                self.status = format!("提交回答失败：{e}");
                cx.notify();
            }
        }
    }

    fn resend_message(&mut self, msg_id: &str, cx: &mut Context<Self>) {
        let Some(msg) = self.state.with(|s| {
            s.repo
                .list_agent_messages()
                .into_iter()
                .find(|m| m.id == msg_id)
        }) else {
            return;
        };
        if msg.role != AgentRole::User {
            return;
        }
        if self.busy {
            self.status = "请先停止当前回合再重发".into();
            cx.notify();
            return;
        }
        self.state.with_mut(|s| {
            s.repo
                .truncate_agent_messages_at(&msg.thread_id, msg.created_at)
        });
        self.state.persist_if_dirty();
        cx.notify();
        self.send(msg.content, cx);
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
        let store = load_providers();
        let mut refs = Vec::new();
        let builtin_on = store
            .providers
            .iter()
            .find(|provider| provider.id == BUILTIN_PROVIDER_ID)
            .is_none_or(|provider| provider.enabled);
        if builtin_on {
            refs.push(BUILTIN_MODEL_REF.to_string());
        }
        for provider in &store.providers {
            if !provider.enabled || provider.id.starts_with("builtin") {
                continue;
            }
            let mut ids: Vec<_> = provider.models.keys().cloned().collect();
            ids.sort();
            for model_id in ids {
                refs.push(format!("{}/{}", provider.id, model_id));
            }
        }
        if refs.is_empty() {
            refs.push(BUILTIN_MODEL_REF.to_string());
        }
        refs
    }

    /// Remove one `@reference` from the draft (the little chip's ×).
    fn drop_draft_reference(&mut self, reference: &str, cx: &mut Context<Self>) {
        let current = self.input.read(cx).value().to_string();
        let needle = format!("@{reference}");
        let words: Vec<&str> = current.split_whitespace().collect();
        let kept: Vec<&str> = words.into_iter().filter(|word| *word != needle).collect();
        let next = kept.join(" ");
        self.pending_edit = Some(next);
        cx.notify();
    }

    /// Insert `text` at the caret; the edit lands on the next render so the
    /// caller does not need a `Window`.
    fn insert_composer_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.pending_insert = Some(text.to_string());
        cx.notify();
    }

    fn set_thread_workspace(&mut self, workspace_id: String, cx: &mut Context<Self>) {
        let tid = self.ensure_thread();
        self.state.with_mut(|s| {
            if let Some(mut t) = s
                .repo
                .list_agent_threads()
                .into_iter()
                .find(|t| t.id == tid)
            {
                t.workspace_id = workspace_id;
                t.updated_at = now_ms();
                s.repo.upsert_agent_thread(t);
            }
        });
        self.branch_cache = None;
        self.mention_cache.clear();
        self.mention_cache_key = None;
        self.state.persist_if_dirty();
        cx.notify();
    }

    fn set_thread_model(&mut self, model_ref: String, cx: &mut Context<Self>) {
        let tid = self.ensure_thread();
        self.state.with_mut(|s| {
            if let Some(mut t) = s
                .repo
                .list_agent_threads()
                .into_iter()
                .find(|t| t.id == tid)
            {
                t.model_ref = model_ref;
                t.updated_at = now_ms();
                s.repo.upsert_agent_thread(t);
            }
        });
        self.state.persist_if_dirty();
        self.status.clear();
        cx.notify();
    }

    fn set_thread_permission(
        &mut self,
        mode: wb_domain::AgentPermissionMode,
        cx: &mut Context<Self>,
    ) {
        let tid = self.ensure_thread();
        self.state.with_mut(|s| {
            if let Some(mut t) = s
                .repo
                .list_agent_threads()
                .into_iter()
                .find(|t| t.id == tid)
            {
                t.permission_mode = mode;
                t.updated_at = now_ms();
                s.repo.upsert_agent_thread(t);
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
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
        let phase = self
            .state
            .with_mut(|s| resolve_approval(&mut s.repo, &approval_id, approved, root.as_deref()));
        let open_view = match &phase {
            Ok(p) => p.open_view().map(|s| s.to_string()),
            Err(e) => {
                log::warn!("审批失败: {e}");
                None
            }
        };
        self.apply_open_view(open_view.as_deref());
        self.state.persist_if_dirty();
        if let Ok(TurnPhase::Continue(cont, _)) = phase {
            self.start_continue_turn(*cont, cx);
        }
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

    /// Insert a quoted snippet (e.g. a tool result) at the caret.
    fn quote_into_composer(&mut self, body: &str, cx: &mut Context<Self>) {
        let clipped: String = body.chars().take(1_500).collect();
        let suffix = if body.chars().count() > 1_500 {
            "…"
        } else {
            ""
        };
        let quote = format!("\n> {}{suffix}\n", clipped.replace('\n', "\n> "));
        self.pending_insert = Some(quote);
        self.status = "已把内容引用到输入框".into();
        cx.notify();
    }

    /// Write the active thread to `<workspace>/.wb/exports/` as Markdown.
    fn export_active_thread(&mut self, cx: &mut Context<Self>) {
        let Some(tid) = self.state.with(|s| s.active_thread_id.clone()) else {
            self.status = "没有可导出的会话".into();
            cx.notify();
            return;
        };
        let (title, messages) = self.state.with(|s| {
            let title = s
                .repo
                .list_agent_threads()
                .into_iter()
                .find(|t| t.id == tid)
                .map(|t| t.title)
                .unwrap_or_else(|| "会话".into());
            (title, s.repo.messages_for_thread(&tid))
        });
        if messages.is_empty() {
            self.status = "会话还没有消息".into();
            cx.notify();
            return;
        }
        let Some(root) = self.workspace_root() else {
            self.status = "当前会话没有工作区，无法导出".into();
            cx.notify();
            return;
        };
        let markdown = crate::thread_export::thread_to_markdown(&title, &messages);
        let stamp = wb_domain::format_local_stamp(now_ms());
        let name = crate::thread_export::export_file_name(&title, &stamp);
        let dir = std::path::Path::new(&root).join(".wb").join("exports");
        // Never overwrite: a second export within the same second would
        // otherwise silently replace the previous file.
        let name =
            crate::thread_export::unique_name(&name, |candidate| dir.join(candidate).exists());
        let path = dir.join(&name);
        match wb_host::write_text(&path, &markdown) {
            Ok(()) => {
                self.status = format!("已导出到 {}", path.display());
                let _ = wb_host::open_path(&dir);
            }
            Err(e) => self.status = format!("导出失败：{e}"),
        }
        cx.notify();
    }

    /// `Alt+↑`: pull the newest user message back into the composer for editing.
    pub fn edit_last_user_message(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tid) = self.state.with(|s| s.active_thread_id.clone()) else {
            return;
        };
        let last = self.state.with(|s| {
            s.repo
                .messages_for_thread(&tid)
                .into_iter()
                .rev()
                .find(|m| m.role == AgentRole::User)
        });
        let Some(last) = last else {
            self.status = "没有可编辑的用户消息".into();
            cx.notify();
            return;
        };
        let text = last.content.clone();
        self.input.update(cx, |input, cx| {
            input.set_value(&text, window, cx);
        });
        self.input.read(cx).focus_handle(cx).focus(window, cx);
        self.history_index = None;
        self.status = "已载入上一条消息，Enter 重新发送".into();
        cx.notify();
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
        let previous = self.state.with(|s| s.active_thread_id.clone());
        let changed = previous.as_deref() != Some(id.as_str());
        if changed {
            // Stash the unsent text per thread before the composer is replaced.
            let text = self.input.read(cx).value().to_string();
            if let Some(prev) = previous.clone() {
                if text.trim().is_empty() {
                    self.drafts.remove(&prev);
                } else {
                    self.drafts.insert(prev, text);
                }
            }
            // A thread switch abandons the in-flight turn, but the partial text
            // belongs to the old thread and must not land in the new one.
            self.abort_turn_quietly(cx);
            // Per-thread caches are keyed by workspace and composer history.
            self.branch_cache = None;
            self.mention_cache.clear();
            self.mention_cache_key = None;
            self.history_index = None;
            self.ghost_suffix = None;
            self.slash_dismissed = false;
            self.pending_edit = Some(self.drafts.get(&id).cloned().unwrap_or_default());
        }
        self.state.with_mut(|s| s.active_thread_id = Some(id));
        self.scroll_chat_to_bottom(cx);
        cx.notify();
    }

    /// Drop the running turn without writing a partial assistant message.
    fn abort_turn_quietly(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            return;
        }
        self.turn_gen = self.turn_gen.wrapping_add(1);
        self.busy = false;
        self.cancel_flag.store(true, Ordering::Relaxed);
        if let Ok(mut draft) = self.stream_draft.lock() {
            draft.clear();
        }
        if let Ok(mut stage) = self.stream_status.lock() {
            stage.clear();
        }
        self.status.clear();
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

    /// Files under the active workspace whose path matches the `@` token at the caret.
    fn live_file_mentions(&mut self, cx: &mut Context<Self>) -> Vec<String> {
        if self.mention_dismissed {
            return Vec::new();
        }
        let value = self.input.read(cx).value().to_string();
        let cursor = self.input.read(cx).cursor().min(value.len());
        let head = &value[..cursor];
        let Some(at) = head.rfind('@') else {
            return Vec::new();
        };
        if at > 0 {
            let prev = head[..at].chars().next_back();
            if !prev.is_some_and(char::is_whitespace) {
                return Vec::new();
            }
        }
        let token = &head[at + 1..];
        if token.contains(char::is_whitespace) {
            return Vec::new();
        }
        let needle = token.to_lowercase();
        let root = self.workspace_root();
        let Some(root) = root else {
            return Vec::new();
        };
        let cache_key = format!("{root}|{needle}");
        if self.mention_cache_key.as_deref() != Some(cache_key.as_str()) {
            let files =
                wb_host::list_files_recursive(std::path::Path::new(&root), 800).unwrap_or_default();
            let mut matched: Vec<String> = files
                .into_iter()
                .filter(|e| needle.is_empty() || e.relative.to_lowercase().contains(&needle))
                .map(|e| e.relative)
                .collect();
            matched.sort_by_key(|p| p.len());
            matched.truncate(8);
            self.mention_cache = matched;
            self.mention_cache_key = Some(cache_key);
            self.mention_selected = 0;
        }
        self.mention_cache.clone()
    }

    fn accept_file_mention(
        &mut self,
        pick: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let value = self.input.read(cx).value().to_string();
        let cursor = self.input.read(cx).cursor().min(value.len());
        let head = &value[..cursor];
        let Some(at) = head.rfind('@') else {
            return false;
        };
        let tail = &value[cursor..];
        let next = format!("{}@{} {}", &value[..at], pick, tail.trim_start());
        let caret = at + 1 + pick.len() + 1;
        self.input.update(cx, |state, cx| {
            state.set_value(next.trim_end().to_string(), window, cx);
            state.set_selected_range(caret..caret, cx);
        });
        self.mention_cache.clear();
        self.mention_cache_key = None;
        self.mention_dismissed = false;
        cx.notify();
        true
    }

    /// Git branch of the active workspace, cached per root.
    fn workspace_branch(&mut self) -> Option<String> {
        let root = self.workspace_root()?;
        if let Some((cached_root, branch)) = &self.branch_cache {
            if cached_root == &root {
                return Some(branch.clone());
            }
        }
        let branch = wb_host::git_branch(std::path::Path::new(&root))?;
        self.branch_cache = Some((root, branch.clone()));
        Some(branch)
    }

    fn workspace_root(&self) -> Option<String> {
        self.state.with(|s| {
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
        })
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

    fn scroll_chat_to_bottom(&mut self, cx: &mut Context<Self>) {
        self.chat_follow = true;
        let handle = self.chat_scroll.clone();
        cx.spawn(async move |_this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(16))
                .await;
            let max = handle.max_offset();
            handle.set_offset(point(px(0.), -max.y.abs()));
        })
        .detach();
    }

    /// Distance from the bottom in pixels; small means the user is at the tail.
    fn chat_distance_from_bottom(&self) -> f32 {
        let max: f32 = self.chat_scroll.max_offset().y.into();
        let cur: f32 = self.chat_scroll.offset().y.into();
        (max.abs() + cur).max(0.0)
    }

    fn chat_near_bottom(&self) -> bool {
        self.chat_distance_from_bottom() < 80.0
    }

    fn recompute_ghost(&mut self, cx: &App) {
        self.ghost_suffix = None;
        if !self.live_slash(cx).is_empty() {
            return;
        }
        let value = self.input.read(cx).value().to_string();
        let cursor = self.input.read(cx).cursor().min(value.len());
        if cursor != value.len() || value.trim().is_empty() {
            return;
        }
        let needle = value.as_str();
        for prev in self.prompt_history.iter().rev() {
            if prev.starts_with(needle) && prev.len() > needle.len() {
                self.ghost_suffix = Some(prev[needle.len()..].to_string());
                return;
            }
        }
    }

    fn accept_ghost(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(suffix) = self.ghost_suffix.take() else {
            return false;
        };
        let next = format!("{}{suffix}", self.input.read(cx).value());
        let len = next.len();
        self.input.update(cx, |state, cx| {
            state.set_value(&next, window, cx);
            state.set_selected_range(len..len, cx);
        });
        cx.notify();
        true
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
        if let Some(text) = self.pending_edit.take() {
            let caret = text.len();
            self.input.update(cx, |input, cx| {
                input.set_value(&text, window, cx);
                input.set_selected_range(caret..caret, cx);
            });
        }
        if let Some(text) = self.pending_insert.take() {
            self.input.update(cx, |input, cx| {
                input.insert(text, window, cx);
            });
        }
        // Growing or shrinking the composer changes the chat viewport; stay pinned
        // to the newest message while the reader has not scrolled away.
        if self.chat_follow {
            let handle = self.chat_scroll.clone();
            cx.on_next_frame(window, move |_this, _window, _cx| {
                let max = handle.max_offset();
                handle.set_offset(point(px(0.), -max.y.abs()));
            });
        }
        // Message-body search is handled by the store, so the query is all the
        // render needs here; no message list is cloned.
        let thread_q = self.thread_query.read(cx).value().trim().to_lowercase();
        let (
            threads,
            messages,
            workspaces,
            approvals,
            perm_label,
            thread_perm,
            model_label,
            active_web_url,
            queued,
            model_ref,
            thread_title,
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
            let title = thread
                .as_ref()
                .map(|t| t.title.clone())
                .unwrap_or_else(|| "新会话".into());
            let perm = thread
                .as_ref()
                .map(|t| permission_mode_label(t.permission_mode))
                .unwrap_or("确认");
            let thread_perm = thread
                .as_ref()
                .map(|t| t.permission_mode)
                .unwrap_or_default();
            let model_ref = thread
                .as_ref()
                .map(|t| t.model_ref.clone())
                .unwrap_or_else(|| BUILTIN_MODEL_REF.to_string());
            let model = model_label_of(&model_ref);
            (
                s.repo.list_agent_threads(),
                messages,
                s.repo.list_agent_workspaces(),
                approvals,
                perm,
                thread_perm,
                model,
                web_url,
                queued,
                model_ref,
                title,
            )
        });
        self.sync_webview(active_web_url.as_deref(), window, cx);
        self.spawn_ask_timers(&approvals, cx);
        let webview_el = self.webview.clone();
        let has_web = active_web_url.is_some() && webview_el.is_some();
        let entity = cx.weak_entity();
        let active = self.state.with(|s| s.active_thread_id.clone());
        let status = self.status.clone();
        let radius = cx.theme().radius;
        let muted = cx.theme().muted_foreground;
        let accent = cx.theme().accent;
        let secondary = cx.theme().secondary;
        let success = cx.theme().success;
        let danger_theme = cx.theme().danger;
        let border = cx.theme().border;
        let danger = cx.theme().danger;

        let ask_card: Option<AnyElement> = approvals
            .iter()
            .find(|a| a.tool_name == "ask_user_question")
            .map(|a| {
                let question = a
                    .args_json
                    .get(0..)
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                    .and_then(|v| {
                        v.get("question")
                            .and_then(|q| q.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_else(|| a.summary.clone());
                let id = a.id.clone();
                v_flex()
                    .gap_2()
                    .p_3()
                    .rounded(radius)
                    .border_1()
                    .border_color(accent.opacity(0.5))
                    .bg(secondary)
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(
                                div()
                                    .text_xs()
                                    .font_bold()
                                    .text_color(accent)
                                    .child("Agent 提问"),
                            )
                            .child(div().text_xs().text_color(muted).child("回答后继续")),
                    )
                    .child(div().text_sm().child(question))
                    .child(
                        h_flex()
                            .gap_2()
                            .items_center()
                            .child(div().flex_1().child(Input::new(&self.ask_input)))
                            .child(
                                Button::new("agent-ask-submit")
                                    .small()
                                    .primary()
                                    .label("回答")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        let text = this.ask_input.read(cx).value().to_string();
                                        if text.trim().is_empty() {
                                            return;
                                        }
                                        this.ask_input.update(cx, |i, cx| {
                                            i.set_value("", window, cx);
                                        });
                                        this.submit_ask_answer(text, cx);
                                    })),
                            )
                            .child(
                                Button::new(SharedString::from(format!("ask-skip-{id}")))
                                    .small()
                                    .ghost()
                                    .label("跳过")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.decide_approval(id.clone(), false, cx);
                                    })),
                            ),
                    )
                    .into_any_element()
            });

        let todos_all = wb_agent::list_todos();
        let goal_chip: Option<AnyElement> = wb_agent::get_goal().map(|goal| {
            let rounds = match goal.max_rounds {
                Some(max) => format!("{}/{}", goal.rounds_started, max),
                None => format!("{} 轮", goal.rounds_started),
            };
            let objective: String = goal.objective.chars().take(28).collect();
            h_flex()
                .gap_1()
                .items_center()
                .px_2()
                .py_0p5()
                .rounded_full()
                .border_1()
                .border_color(accent.opacity(0.6))
                .child(
                    div()
                        .text_xs()
                        .font_bold()
                        .text_color(accent)
                        .child(format!("目标 {rounds}")),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .child(format!("{objective} · {}", goal.status)),
                )
                .into_any_element()
        });
        let todo_chip: Option<AnyElement> = {
            let todos = wb_agent::list_todos();
            (!todos.is_empty()).then(|| {
                let done = todos.iter().filter(|t| t.status == "completed").count();
                let running = todos.iter().find(|t| t.status == "in_progress").map(|t| {
                    let text: String = t.content.chars().take(20).collect();
                    text
                });
                h_flex()
                    .gap_1()
                    .items_center()
                    .px_2()
                    .py_0p5()
                    .rounded_full()
                    .border_1()
                    .border_color(border)
                    .child(
                        div()
                            .text_xs()
                            .font_bold()
                            .child(format!("待办 {done}/{}", todos.len())),
                    )
                    .when_some(running, |row, text| {
                        row.child(div().text_xs().text_color(muted).child(format!("· {text}")))
                    })
                    .into_any_element()
            })
        };

        let approval_rows: Vec<_> = approvals
            .into_iter()
            .filter(|a| a.tool_name != "ask_user_question")
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
        let msg_filter = self.msg_filter;
        let slash_hits = self.live_slash(cx);
        let mention_hits = self.live_file_mentions(cx);
        let mention_selected = self.mention_selected;
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
        // Searching message bodies walks the whole store, so ask the store once
        // for the matching thread ids instead of cloning every message here.
        let body_hits = if thread_q.is_empty() {
            std::collections::HashSet::new()
        } else {
            self.state
                .with(|s| s.repo.agent_thread_ids_matching(&thread_q))
        };
        let thread_rows: Vec<_> = threads
            .into_iter()
            .filter(|t| show_archived || t.archived_at.is_none())
            .filter(|t| !self.pinned_only || t.pinned_at.is_some())
            .filter(|t| {
                ws_filter
                    .as_ref()
                    .map(|id| &t.workspace_id == id)
                    .unwrap_or(true)
            })
            .filter(|t| {
                thread_q.is_empty()
                    || t.title.to_lowercase().contains(&thread_q)
                    || body_hits.contains(&t.id)
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
                // When the match is in a message body rather than the title,
                // show a short snippet so the row is identifiable.
                let snippet = if !thread_q.is_empty() && !t.title.to_lowercase().contains(&thread_q)
                {
                    let tid = t.id.clone();
                    self.state
                        .with(|s| s.repo.agent_message_excerpt(&tid, &thread_q))
                } else {
                    None
                };
                h_flex()
                    .w_full()
                    .items_center()
                    .gap_1()
                    .p_2()
                    .rounded(radius)
                    .when(selected, |d| d.bg(accent))
                    .hover(|d| d.bg(accent.opacity(0.5)))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .gap_0p5()
                            .child(
                                div()
                                    .id(SharedString::from(format!("thread-{id}")))
                                    .w_full()
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
                            .when_some(snippet, |col, text| {
                                col.child(
                                    div()
                                        .w_full()
                                        .text_xs()
                                        .text_color(muted)
                                        .overflow_hidden()
                                        .child(text),
                                )
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
            .filter(|m| match msg_filter {
                MsgFilter::All => true,
                MsgFilter::Tools => matches!(m.role, AgentRole::Tool),
                MsgFilter::Errors => is_error_message(m),
                MsgFilter::User => matches!(m.role, AgentRole::User),
            })
            .filter(|m| {
                find_q.is_empty()
                    || m.content.to_lowercase().contains(&find_q)
                    || m.tool_name
                        .as_deref()
                        .is_some_and(|n| n.to_lowercase().contains(&find_q))
            })
            .collect();
        let visible_count = visible_messages.len();
        let empty_chat =
            visible_messages.is_empty() && find_q.is_empty() && msg_filter == MsgFilter::All;
        let filter_miss =
            visible_messages.is_empty() && (!find_q.is_empty() || msg_filter != MsgFilter::All);
        let draft_text = self.stream_draft_text();
        let draft_stage = self.stream_status_text();
        // Snapshot the failure list before the rows consume `visible_messages`.
        let error_summary: Vec<(String, String)> = if msg_filter == MsgFilter::Errors {
            visible_messages
                .iter()
                .map(|m| {
                    let tool = m.tool_name.clone().unwrap_or_else(|| "tool".into());
                    let body: String = m.content.replace('\n', " ").chars().take(160).collect();
                    (tool, body)
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut last_day = String::new();
        let mut tool_group: Vec<AgentMessage> = Vec::new();
        let mut tool_group_day = String::new();
        let mut message_rows: Vec<AnyElement> = Vec::new();
        let chat_palette = ChatPalette {
            radius,
            muted,
            accent,
            secondary,
            success,
            danger: danger_theme,
            workspace_root: self.workspace_root(),
        };
        for m in visible_messages {
            let day = format_local_day(m.created_at);
            // Batch consecutive tool results into one collapsed row.
            if m.role == AgentRole::Tool {
                if tool_group.is_empty() {
                    tool_group_day = day.clone();
                }
                tool_group.push(m);
                continue;
            }
            if !tool_group.is_empty() {
                message_rows.extend(flush_tool_group(
                    std::mem::take(&mut tool_group),
                    &tool_group_day,
                    &mut last_day,
                    &self.expanded_tools,
                    chat_palette.clone(),
                    entity.clone(),
                ));
            }
            if day != last_day {
                last_day = day.clone();
                message_rows.push(day_marker(&day, muted, m.created_at));
            }
            message_rows.push(render_chat_message(
                &m,
                &self.expanded_tools,
                chat_palette.clone(),
                entity.clone(),
            ));
        }
        if !tool_group.is_empty() {
            message_rows.extend(flush_tool_group(
                tool_group,
                &tool_group_day,
                &mut last_day,
                &self.expanded_tools,
                chat_palette.clone(),
                entity.clone(),
            ));
        }
        let ghost = self.ghost_suffix.clone();

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
                    .child(Input::new(&self.thread_query).small().cleanable(true))
                    .child(
                        h_flex()
                            .gap_1()
                            .items_center()
                            .child(
                                Button::new("thread-pinned-only")
                                    .xsmall()
                                    .ghost()
                                    .label("仅置顶")
                                    .selected(self.pinned_only)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.pinned_only = !this.pinned_only;
                                        cx.notify();
                                    })),
                            )
                            .when(!thread_q.is_empty(), |row| {
                                row.child(
                                    div()
                                        .flex_1()
                                        .text_xs()
                                        .text_color(muted)
                                        .child(format!("{} 个匹配", thread_rows.len())),
                                )
                            }),
                    )
                    .when(!thread_q.is_empty() && thread_rows.is_empty(), |col| {
                        col.child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child("没有标题匹配的会话"),
                        )
                    })
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
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .text_sm()
                                    .font_semibold()
                                    .overflow_x_hidden()
                                    .text_ellipsis()
                                    .child(thread_title),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(muted)
                                    .child("可用 /rename 改标题"),
                            )
                            .when_some(goal_chip, |row, chip| row.child(chip))
                            .when_some(todo_chip, |row, chip| row.child(chip))
                            .child(
                                Button::new("agent-export")
                                    .xsmall()
                                    .ghost()
                                    .label("导出")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.export_active_thread(cx);
                                    })),
                            )
                            .when(!todos_all.is_empty(), |row| {
                                row.child(
                                    Button::new("agent-todo-toggle")
                                        .xsmall()
                                        .ghost()
                                        .label(if self.show_todos {
                                            "收起待办"
                                        } else {
                                            "待办详情"
                                        })
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.show_todos = !this.show_todos;
                                            cx.notify();
                                        })),
                                )
                            }),
                    )
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
                    .when(self.show_todos && !todos_all.is_empty(), |col| {
                        col.child(
                            v_flex()
                                .w_full()
                                .gap_1()
                                .p_2()
                                .rounded(radius)
                                .border_1()
                                .border_color(border)
                                .children(todos_all.iter().map(|todo| {
                                    let mark = match todo.status.as_str() {
                                        "completed" => "✓",
                                        "in_progress" => "▸",
                                        _ => "·",
                                    };
                                    let color = if todo.status == "completed" {
                                        muted
                                    } else if todo.status == "in_progress" {
                                        accent
                                    } else {
                                        cx.theme().foreground
                                    };
                                    h_flex()
                                        .gap_2()
                                        .items_start()
                                        .child(div().text_xs().text_color(muted).child(mark))
                                        .child(
                                            div()
                                                .flex_1()
                                                .text_xs()
                                                .text_color(color)
                                                .child(todo.content.clone()),
                                        )
                                        .into_any_element()
                                })),
                        )
                    })
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
                                h_flex()
                                    .gap_1()
                                    .items_center()
                                    .children(
                                        [
                                            (MsgFilter::All, "全部"),
                                            (MsgFilter::User, "我"),
                                            (MsgFilter::Tools, "工具"),
                                            (MsgFilter::Errors, "问题"),
                                        ]
                                        .into_iter()
                                        .map(|(filter, label)| {
                                            Button::new(SharedString::from(format!(
                                                "msg-filter-{label}"
                                            )))
                                            .xsmall()
                                            .ghost()
                                            .label(label)
                                            .selected(msg_filter == filter)
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.msg_filter = filter;
                                                cx.notify();
                                            }))
                                            .into_any_element()
                                        }),
                                    ),
                            )
                            .when(msg_filter == MsgFilter::Errors && !error_summary.is_empty(), |row| {
                                let entity = entity.clone();
                                let rows: Vec<(String, String)> = error_summary.clone();
                                row.child(
                                    Button::new("agent-errors-copy")
                                        .xsmall()
                                        .ghost()
                                        .label("复制小结")
                                        .on_click(move |_, _, cx| {
                                            let mut out = String::from("失败的工具调用：\n");
                                            for (tool, body) in &rows {
                                                out.push_str(&format!("- {tool}: {body}\n"));
                                            }
                                            cx.write_to_clipboard(
                                                gpui::ClipboardItem::new_string(out),
                                            );
                                            if let Some(e) = entity.upgrade() {
                                                e.update(cx, |this, cx| {
                                                    this.status =
                                                        format!("已复制 {} 条失败调用", rows.len());
                                                    cx.notify();
                                                });
                                            }
                                        }),
                                )
                            })
                            .child({
                                let ctx_frac = (ctx_pct / 100.0).min(1.0);
                                let ctx_color = if ctx_pct >= 80.0 { danger } else { accent };
                                h_flex()
                                    .gap_1()
                                    .items_center()
                                    .child(
                                        div()
                                            .w(px(64.))
                                            .h(px(4.))
                                            .rounded_full()
                                            .bg(cx.theme().border)
                                            .child(
                                                div()
                                                    .h_full()
                                                    .rounded_full()
                                                    .bg(ctx_color)
                                                    .w(relative(ctx_frac)),
                                            ),
                                    )
                                    .child(
                                        div()
                                            .text_xs()
                                            .text_color(muted)
                                            .child(format!("{ctx_pct:.0}%")),
                                    )
                                    .when(ctx_pct >= 80.0, |row| {
                                        row.child(
                                            Button::new("agent-compact-now")
                                                .xsmall()
                                                .ghost()
                                                .label("压缩")
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.compact_history(cx);
                                                })),
                                        )
                                    })
                            })
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
                    .when_some(ask_card, |col, card| col.child(card))
                    .when(!approval_rows.is_empty(), |col| {
                        col.child(v_flex().gap_2().children(approval_rows))
                    })
                    .when(!find_q.is_empty(), |col| {
                        let hits = visible_count;
                        let clearing = find_q.clone();
                        col.child(
                            h_flex()
                                .w_full()
                                .gap_2()
                                .items_center()
                                .px_2()
                                .py_1()
                                .rounded(px(8.))
                                .border_1()
                                .border_color(accent.opacity(0.5))
                                .bg(secondary)
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(accent)
                                        .child(format!("筛选「{clearing}」· {hits} 条")),
                                )
                                .child(div().flex_1())
                                .child(
                                    Button::new("agent-find-clear-pill")
                                        .xsmall()
                                        .ghost()
                                        .label("Esc 清除")
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.find.update(cx, |i, cx| {
                                                i.set_value("", window, cx);
                                            });
                                            cx.notify();
                                        })),
                                ),
                        )
                    })
                    .child(if empty_chat {
                        v_flex()
                            .flex_1()
                            .gap_3()
                            .justify_center()
                            .items_center()
                            .child(div().text_lg().font_bold().child("开始一段 Agent 对话"))
                            .child(div().text_xs().text_color(muted).child(
                                "Enter 发送 · Shift+Enter 换行 · @ 引用文件 · / 斜杠命令 · ↑↓ 历史",
                            ))
                            .child(
                                v_flex().gap_1().children(
                                    [
                                        ("@ 引用工作区文件", "@"),
                                        ("/ 查看斜杠命令", "/"),
                                        ("Alt+↑ 编辑上一条消息", "alt-↑"),
                                        ("Ctrl+N 聚焦输入框", "ctrl-n"),
                                    ]
                                    .into_iter()
                                    .map(|(label, id)| {
                                        h_flex()
                                            .gap_2()
                                            .items_center()
                                            .child(
                                                div()
                                                    .px_1()
                                                    .rounded(px(3.))
                                                    .bg(border)
                                                    .text_xs()
                                                    .text_color(muted)
                                                    .child(id.to_string()),
                                            )
                                            .child(div().text_xs().text_color(muted).child(label))
                                            .into_any_element()
                                    }),
                                ),
                            )
                            .child(
                                h_flex().gap_2().flex_wrap().children(
                                    ["/task_list", "/project_list", "/goal", "/clear", "/compact"]
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
                            .gap_2()
                            .justify_center()
                            .items_center()
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(muted)
                                    .child("没有匹配筛选条件的消息"),
                            )
                            .child(
                                Button::new("agent-find-clear")
                                    .xsmall()
                                    .ghost()
                                    .label("清空筛选")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.find.update(cx, |i, cx| {
                                            i.set_value("", window, cx);
                                        });
                                        cx.notify();
                                    })),
                            )
                            .into_any_element()
                    } else {
                        v_flex()
                            .id("agent-chat-scroll")
                            .flex_1()
                            .gap_2()
                            .overflow_y_scroll()
                            .track_scroll(&self.chat_scroll)
                            .vertical_scrollbar(&self.chat_scroll)
                            .on_scroll(cx.listener(
                                |this, event: &ScrollEvent, _window: &mut Window, cx| {
                                    // Scrolling up detaches the view from the tail; scrolling
                                    // back to the bottom re-arms following.
                                    let up = match event.delta {
                                        ScrollDelta::Pixels(p) => f32::from(p.y) > 0.0,
                                        ScrollDelta::Lines(p) => p.y > 0.0,
                                    };
                                    if up {
                                        this.chat_follow = false;
                                    } else if this.chat_near_bottom() {
                                        this.chat_follow = true;
                                    }
                                    cx.notify();
                                },
                            ))
                            .children(message_rows)
                            .when(self.busy, |col| {
                                let draft = draft_text.clone();
                                col.child(
                                    v_flex()
                                        .gap_1()
                                        .p_2()
                                        .rounded(radius)
                                        .max_w(relative(0.86))
                                        .bg(secondary)
                                        .border_1()
                                        .border_color(accent.opacity(0.45))
                                        .child(
                                            h_flex()
                                                .gap_2()
                                                .items_center()
                                                .child(
                                                    div()
                                                        .text_xs()
                                                        .font_bold()
                                                        .text_color(muted)
                                                        .child("Agent"),
                                                )
                                                .child(div().text_xs().text_color(muted).child(
                                                    if draft_stage.is_empty() {
                                                        "正在回复…".to_string()
                                                    } else {
                                                        draft_stage.clone()
                                                    },
                                                )),
                                        )
                                        .child(
                                            div()
                                                .id("agent-stream-draft")
                                                .text_sm()
                                                .text_color(if draft.trim().is_empty() {
                                                    muted
                                                } else {
                                                    cx.theme().foreground
                                                })
                                                .max_h(px(100.))
                                                .overflow_y_scroll()
                                                .child(if draft.trim().is_empty() {
                                                    "…".to_string()
                                                } else {
                                                    draft
                                                }),
                                        ),
                                )
                            })
                            .into_any_element()
                    })
                    .when(!self.chat_follow, |col| {
                        col.child(
                            h_flex().w_full().justify_center().child(
                                Button::new("agent-jump-bottom")
                                    .xsmall()
                                    .outline()
                                    .label("↓ 回到底部")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.scroll_chat_to_bottom(cx);
                                        cx.notify();
                                    })),
                            ),
                        )
                    })
                    .when(!queued.is_empty(), |col| {
                        let tid = active.clone();
                        col.child(
                            v_flex()
                                .w_full()
                                .gap_1()
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(muted)
                                        .child(format!("队列 {} 条", queued.len())),
                                )
                                .children(queued.iter().enumerate().map(|(index, text)| {
                                    let preview: String = text.chars().take(60).collect();
                                    let more = text.chars().count() > 60;
                                    let tid = tid.clone();
                                    h_flex()
                                        .w_full()
                                        .gap_2()
                                        .items_center()
                                        .p_1()
                                        .rounded(radius)
                                        .border_1()
                                        .border_color(border)
                                        .child(
                                            div()
                                                .flex_1()
                                                .text_xs()
                                                .text_color(muted)
                                                .overflow_hidden()
                                                .child(if more {
                                                    format!("{preview}…")
                                                } else {
                                                    preview
                                                }),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!(
                                                "queue-edit-{index}"
                                            )))
                                            .xsmall()
                                            .ghost()
                                            .label("编辑")
                                            .on_click(cx.listener({
                                                let tid = tid.clone();
                                                move |this, _, window, cx| {
                                                    if let Some(tid) = tid.clone() {
                                                        this.take_queued_into_input(
                                                            index, tid, window, cx,
                                                        );
                                                    }
                                                }
                                            })),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!(
                                                "queue-del-{index}"
                                            )))
                                            .xsmall()
                                            .ghost()
                                            .label("移除")
                                            .on_click(cx.listener({
                                                let tid = tid.clone();
                                                move |this, _, _, cx| {
                                                    if let Some(tid) = tid.clone() {
                                                        this.remove_queued(index, tid, cx);
                                                    }
                                                }
                                            })),
                                        )
                                })),
                        )
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
                                // Cap the list so a long catalogue scrolls instead of
                                // pushing the composer off screen.
                                .max_h(px(220.))
                                .overflow_y_scrollbar()
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
                                }))
                                .child(
                                    h_flex()
                                        .gap_2()
                                        .items_center()
                                        .pt_1()
                                        .px_2()
                                        .child(
                                            div()
                                                .text_xs()
                                                .text_color(muted)
                                                .child("↑↓ 选择 · Tab/Enter 补全 · Esc 关闭"),
                                        ),
                                ),
                        )
                    })
                    .when(!mention_hits.is_empty(), |col| {
                        col.child(
                            v_flex()
                                .gap_0p5()
                                .p_2()
                                .rounded(radius)
                                .border_1()
                                .border_color(border)
                                .bg(secondary)
                                .max_h(px(220.))
                                .overflow_y_scrollbar()
                                .children(mention_hits.iter().enumerate().map(|(i, path)| {
                                    let pick = path.clone();
                                    h_flex()
                                        .id(SharedString::from(format!("mention-hit-{i}")))
                                        .gap_2()
                                        .px_2()
                                        .py_1()
                                        .rounded(radius)
                                        .cursor_pointer()
                                        .when(i == mention_selected, |row| {
                                            row.bg(accent.opacity(0.35))
                                        })
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.mention_selected = i;
                                            this.accept_file_mention(&pick, window, cx);
                                        }))
                                        .child(div().text_xs().child(path.clone()))
                                        .into_any_element()
                                })),
                        )
                    })
                    .child(
                        // Hadron-style composer: one rounded card that owns the
                        // focus ring, the live preview, the input and a tool row.
                        {
                            let is_focused =
                                self.input.read(cx).focus_handle(cx).is_focused(window);
                            let draft = self.input.read(cx).value().to_string();
                            let draft_empty = draft.trim().is_empty();
                            let draft_chars = draft.chars().count();
                            let preview_on = self.composer_preview && !draft_empty;
                            let draft_refs = draft_file_refs(&draft);
                            let branch = self.workspace_branch();
                            let active_ws = self.state.with(|s| {
                                s.active_thread_id
                                    .as_ref()
                                    .and_then(|id| {
                                        s.repo
                                            .list_agent_threads()
                                            .into_iter()
                                            .find(|t| &t.id == id)
                                    })
                                    .map(|t| t.workspace_id)
                            });
                            let root_name = self
                                .workspace_root()
                                .and_then(|root| {
                                    std::path::Path::new(&root)
                                        .file_name()
                                        .map(|n| n.to_string_lossy().into_owned())
                                })
                                .unwrap_or_else(|| "本机".into());
                            v_flex()
                                .id("agent-composer")
                                .w_full()
                                .gap_1p5()
                                .p_2p5()
                                .rounded(px(22.))
                                .bg(secondary)
                                .border_1()
                                .border_color(if self.drag_hover {
                                    accent
                                } else if is_focused {
                                    accent.opacity(0.65)
                                } else {
                                    border
                                })
                                .when(self.drag_hover, |col| {
                                    col.child(
                                        div()
                                            .w_full()
                                            .pb_1()
                                            .text_xs()
                                            .text_color(accent)
                                            .child("松开即可引用这些文件"),
                                    )
                                })
                                .on_drag_move::<gpui::ExternalPaths>(cx.listener(
                                    |this, _: &gpui::DragMoveEvent<gpui::ExternalPaths>, _, cx| {
                                        if !this.drag_hover {
                                            this.drag_hover = true;
                                            cx.notify();
                                        }
                                    },
                                ))
                                .on_file_drop_exit(cx.listener(
                                    |this, _, _, cx| {
                                        if this.drag_hover {
                                            this.drag_hover = false;
                                            cx.notify();
                                        }
                                    },
                                ))
                                .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                                    this.drag_hover = false;
                                    let root = this.workspace_root();
                                    let mut names: Vec<String> = Vec::new();
                                    for path in paths.paths() {
                                        let label = match &root {
                                            Some(root) => path
                                                .strip_prefix(std::path::Path::new(root))
                                                .map(|p| p.to_string_lossy().into_owned())
                                                .unwrap_or_else(|_| {
                                                    path.file_name()
                                                        .map(|n| n.to_string_lossy().into_owned())
                                                        .unwrap_or_else(|| {
                                                            path.to_string_lossy().into_owned()
                                                        })
                                                }),
                                            None => path
                                                .file_name()
                                                .map(|n| n.to_string_lossy().into_owned())
                                                .unwrap_or_else(|| {
                                                    path.to_string_lossy().into_owned()
                                                }),
                                        };
                                        names.push(format!("@{label}"));
                                    }
                                    if names.is_empty() {
                                        return;
                                    }
                                    let inserted = names.join(" ");
                                    let current = this.input.read(cx).value().to_string();
                                    let next = if current.trim().is_empty() {
                                        inserted
                                    } else {
                                        format!("{current} {inserted}")
                                    };
                                    let len = next.len();
                                    this.input.update(cx, |state, cx| {
                                        state.set_value(&next, window, cx);
                                        state.set_selected_range(len..len, cx);
                                    });
                                    window.focus(&this.input.focus_handle(cx), cx);
                                    this.status = format!("已插入 {} 个文件引用", names.len());
                                    cx.notify();
                                }))
                                .when(preview_on, |col| {
                                    col.child(
                                        v_flex()
                                            .w_full()
                                            .gap_1()
                                            .pb_1p5()
                                            .border_b_1()
                                            .border_color(border)
                                            .child(
                                                div()
                                                    .text_xs()
                                                    .italic()
                                                    .text_color(muted)
                                                    .child("预览"),
                                            )
                                            .child(
                                                div()
                                                    .id("agent-composer-preview")
                                                    .w_full()
                                                    .max_h(px(150.))
                                                    .overflow_y_scroll()
                                                    .track_scroll(&self.composer_preview_scroll)
                                                    .child(TextView::markdown(
                                                        "agent-composer-preview-md",
                                                        draft.clone(),
                                                    )),
                                            ),
                                    )
                                })
                                .child(
                                    // Pill row: attach · input · model · mic · send.
                                    h_flex()
                                        .w_full()
                                        .items_end()
                                        .gap_1p5()
                                        .child(
                                            {
                                                let entity = entity.clone();
                                                let attach = Button::new("agent-attach")
                                                    .ghost()
                                                    .xsmall()
                                                    .icon(IconName::Plus);
                                                attach.dropdown_menu_with_anchor(
                                                    Anchor::TopLeft,
                                                    move |menu, _, _| {
                                                        let mut menu = menu;
                                                        let ent_file = entity.clone();
                                                        let ent_cmd = entity.clone();
                                                        let ent_term = entity.clone();
                                                        let ent_compact = entity.clone();
                                                        let ent_help = entity.clone();
                                                        menu = menu
                                                            .item(
                                                                PopupMenuItem::new("@ 引用文件")
                                                                    .on_click(move |_, _, app| {
                                                                        if let Some(e) = ent_file.upgrade() {
                                                                            e.update(app, |this, cx| {
                                                                                this.insert_composer_text("@", cx);
                                                                            });
                                                                        }
                                                                    }),
                                                            )
                                                            .item(
                                                                PopupMenuItem::new("/ 斜杠命令")
                                                                    .on_click(move |_, _, app| {
                                                                        if let Some(e) = ent_cmd.upgrade() {
                                                                            e.update(app, |this, cx| {
                                                                                this.insert_composer_text("/", cx);
                                                                            });
                                                                        }
                                                                    }),
                                                            );
                                                        menu = menu
                                                            .separator()
                                                            .item(
                                                                PopupMenuItem::new("压缩上下文")
                                                                    .on_click(move |_, _, app| {
                                                                        if let Some(e) = ent_compact.upgrade() {
                                                                            e.update(app, |this, cx| {
                                                                                this.compact_history(cx);
                                                                            });
                                                                        }
                                                                    }),
                                                            )
                                                            .item(
                                                                PopupMenuItem::new("打开终端")
                                                                    .on_click(move |_, _, app| {
                                                                        if let Some(e) = ent_term.upgrade() {
                                                                            e.update(app, |this, cx| {
                                                                                this.open_terminal(cx);
                                                                            });
                                                                        }
                                                                    }),
                                                            )
                                                            .item(
                                                                PopupMenuItem::new("清空本会话")
                                                                    .on_click(move |_, _, app| {
                                                                        if let Some(e) = ent_help.upgrade() {
                                                                            e.update(app, |this, cx| {
                                                                                this.clear_active_thread(cx);
                                                                            });
                                                                        }
                                                                    }),
                                                            );
                                                        menu
                                                    },
                                                )
                                            }
                                        )
                                        .child(
                                            v_flex()
                                                .flex_1()
                                                .min_w_0()
                                                .gap_0p5()
                                        .capture_action(cx.listener(
                                            |this, _: &MoveDown, window, cx| {
                                                let hits = this.live_slash(cx);
                                                if !hits.is_empty() {
                                                    this.slash_selected =
                                                        (this.slash_selected + 1) % hits.len();
                                                    cx.notify();
                                                    cx.stop_propagation();
                                                } else {
                                                    let mentions = this.live_file_mentions(cx);
                                                    if !mentions.is_empty() {
                                                        this.mention_selected =
                                                            (this.mention_selected + 1)
                                                                % mentions.len();
                                                        cx.notify();
                                                        cx.stop_propagation();
                                                    } else if this.history_index.is_some()
                                                        && this.composer_on_last_line(cx)
                                                        && this
                                                            .navigate_prompt_history(1, window, cx)
                                                    {
                                                        cx.stop_propagation();
                                                    }
                                                }
                                            },
                                        ))
                                        .capture_action(cx.listener(
                                            |this, _: &MoveUp, window, cx| {
                                                let hits = this.live_slash(cx);
                                                if !hits.is_empty() {
                                                    this.slash_selected = this
                                                        .slash_selected
                                                        .checked_sub(1)
                                                        .unwrap_or(hits.len() - 1);
                                                    cx.notify();
                                                    cx.stop_propagation();
                                                } else {
                                                    let mentions = this.live_file_mentions(cx);
                                                    if !mentions.is_empty() {
                                                        this.mention_selected = this
                                                            .mention_selected
                                                            .checked_sub(1)
                                                            .unwrap_or(mentions.len() - 1);
                                                        cx.notify();
                                                        cx.stop_propagation();
                                                    } else if this.composer_on_first_line(cx)
                                                        && this
                                                            .navigate_prompt_history(-1, window, cx)
                                                    {
                                                        cx.stop_propagation();
                                                    }
                                                }
                                            },
                                        ))
                                        .capture_action(cx.listener(
                                            |this, _: &IndentInline, window, cx| {
                                                let mentions = this.live_file_mentions(cx);
                                                let picked = mentions
                                                    .get(this.mention_selected)
                                                    .cloned()
                                                    .map(|pick| {
                                                        this.accept_file_mention(&pick, window, cx)
                                                    })
                                                    .unwrap_or(false);
                                                if picked
                                                    || this.accept_slash_if_open(window, cx)
                                                    || this.accept_ghost(window, cx)
                                                {
                                                    cx.stop_propagation();
                                                }
                                            },
                                        ))
                                        .capture_action(cx.listener(
                                            |this, _: &MoveRight, window, cx| {
                                                let (cursor, len) = {
                                                    let state = this.input.read(cx);
                                                    (state.cursor(), state.value().len())
                                                };
                                                if cursor == len && this.accept_ghost(window, cx) {
                                                    cx.stop_propagation();
                                                }
                                            },
                                        ))
                                        .capture_action(cx.listener(
                                            |this, _: &InputEscape, window, cx| {
                                                if !this.live_slash(cx).is_empty() {
                                                    this.slash_dismissed = true;
                                                    this.slash_selected = 0;
                                                    cx.notify();
                                                    cx.stop_propagation();
                                                } else if !this.mention_cache.is_empty() {
                                                    this.mention_dismissed = true;
                                                    cx.notify();
                                                    cx.stop_propagation();
                                                } else if this.composer_preview {
                                                    this.composer_preview = false;
                                                    cx.notify();
                                                    cx.stop_propagation();
                                                } else if !this.find.read(cx).value().is_empty() {
                                                    let find = this.find.clone();
                                                    find.update(cx, |i, cx| {
                                                        i.set_value("", window, cx);
                                                    });
                                                    cx.notify();
                                                    cx.stop_propagation();
                                                } else if this.ghost_suffix.take().is_some() {
                                                    cx.notify();
                                                    cx.stop_propagation();
                                                }
                                            },
                                        ))
                                        .child(
                                            Textarea::new(&self.input)
                                                .appearance(false)
                                                .bordered(false),
                                        )
                                        .when(!draft_refs.is_empty(), |col| {
                                            col.child(
                                                h_flex()
                                                    .w_full()
                                                    .gap_1()
                                                    .flex_wrap()
                                                    .children(draft_refs.iter().enumerate().map(
                                                        |(ix, reference)| {
                                                            let entity = entity.clone();
                                                            let target = reference.clone();
                                                            let is_image =
                                                                crate::composer_text::is_image_path(
                                                                    reference,
                                                                );
                                                            h_flex()
                                                                .id(SharedString::from(format!(
                                                                    "draft-ref-{ix}"
                                                                )))
                                                                .items_center()
                                                                .gap_1()
                                                                .px_1p5()
                                                                .py_0p5()
                                                                .rounded(px(6.))
                                                                .border_1()
                                                                .border_color(if is_image {
                                                                    accent.opacity(0.5)
                                                                } else {
                                                                    border
                                                                })
                                                                .text_xs()
                                                                .text_color(muted)
                                                                .child(
                                                                    Icon::new(IconName::File)
                                                                        .xsmall(),
                                                                )
                                                                .child(reference.clone())
                                                                .child(
                                                                    div()
                                                                        .id(SharedString::from(
                                                                            format!("draft-ref-x-{ix}"),
                                                                        ))
                                                                        .cursor_pointer()
                                                                        .hover(|s| s.text_color(danger))
                                                                        .child(
                                                                            Icon::new(IconName::Close)
                                                                                .xsmall(),
                                                                        )
                                                                        .on_click(move |_, _, app| {
                                                                            if let Some(e) =
                                                                                entity.upgrade()
                                                                            {
                                                                                let target =
                                                                                    target.clone();
                                                                                e.update(app, |this, cx| {
                                                                                    this.drop_draft_reference(&target, cx);
                                                                                });
                                                                            }
                                                                        }),
                                                                )
                                                                .into_any_element()
                                                        },
                                                    )),
                                            )
                                        })
                                        .when_some(ghost, |col, suffix| {
                                            col.child(
                                                h_flex()
                                                    .items_center()
                                                    .gap_1()
                                                    .child(
                                                        div()
                                                            .px_1()
                                                            .rounded(px(3.))
                                                            .bg(border)
                                                            .text_xs()
                                                            .text_color(muted)
                                                            .child("Tab"),
                                                    )
                                                    .child(
                                                        div()
                                                            .text_xs()
                                                            .text_color(muted)
                                                            .child(format!("补全 …{suffix}")),
                                                    ),
                                            )
                                        }),
                                        )
                                        .child(
                                            // Right cluster inside the pill: model picker,
                                            // voice, then the round send/stop button.
                                            h_flex()
                                                .items_center()
                                                .gap_1()
                                                .flex_shrink_0()
                                                .child({
                                                    let entity = entity.clone();
                                                    let current = model_ref.clone();
                                                    Button::new("agent-model-picker")
                                                        .ghost()
                                                        .xsmall()
                                                        .label(model_label.clone())
                                                        .icon(IconName::ChevronDown)
                                                        .dropdown_menu_with_anchor(
                                                        Anchor::TopRight,
                                                        move |menu, _, _| {
                                                            let mut menu = menu;
                                                            for model in AgentPane::available_model_refs() {
                                                                let entity = entity.clone();
                                                                let pick = model.clone();
                                                                menu = menu.item(
                                                                    PopupMenuItem::new(model_label_of(&model))
                                                                        .checked(current == model)
                                                                        .on_click(move |_, _, app| {
                                                                            if let Some(e) = entity.upgrade() {
                                                                                let pick = pick.clone();
                                                                                e.update(app, |this, cx| {
                                                                                    this.set_thread_model(pick, cx);
                                                                                });
                                                                            }
                                                                        }),
                                                                );
                                                            }
                                                            menu
                                                        },
                                                    )
                                                })
                                                .child(
                                                    div()
                                                        .id("agent-mic")
                                                        .flex()
                                                        .items_center()
                                                        .justify_center()
                                                        .size(px(28.))
                                                        .rounded_full()
                                                        .cursor_pointer()
                                                        .hover(|s| s.bg(border))
                                                        .child(
                                                            Icon::new(IconName::Mic)
                                                                .xsmall()
                                                                .text_color(muted),
                                                        )
                                                        .on_click(cx.listener(|this, _, _, cx| {
                                                            let on = this.state.with(|s| {
                                                                s.prefs.voice.enabled
                                                                    || s.prefs.voice.caps_lock_ptt
                                                            });
                                                            wb_host::voice_ptt_set_enabled(true);
                                                            this.status = if on {
                                                                "按住 Caps Lock 说话".into()
                                                            } else {
                                                                "语音未启用，可到设置 → 语音开启（Caps Lock 说话）"
                                                                    .into()
                                                            };
                                                            cx.notify();
                                                        })),
                                                )
                                                .child({
                                                    let busy = self.busy;
                                                    let enabled = !draft_empty;
                                                    let tooltip = if busy {
                                                        "停止当前回合"
                                                    } else if enabled {
                                                        "发送（Enter）"
                                                    } else {
                                                        "输入内容后可发送"
                                                    };
                                                    div()
                                                        .id("agent-send")
                                                        .flex()
                                                        .items_center()
                                                        .justify_center()
                                                        .size(px(30.))
                                                        .flex_shrink_0()
                                                        .rounded_full()
                                                        .bg(if busy {
                                                            danger
                                                        } else if enabled {
                                                            accent
                                                        } else {
                                                            border
                                                        })
                                                        .when(!busy && !enabled, |s| s.cursor_default())
                                                        .when(busy || enabled, |s| s.cursor_pointer())
                                                        .tooltip(move |window, cx| {
                                                            gpui_kit::component::tooltip::Tooltip::new(
                                                                tooltip,
                                                            )
                                                            .build(window, cx)
                                                        })
                                                        .hover(|s| s.opacity(0.85))
                                                        .child(
                                                            Icon::new(if busy {
                                                                IconName::Square
                                                            } else {
                                                                IconName::ArrowUp
                                                            })
                                                            .small()
                                                            .text_color(if busy || enabled {
                                                                cx.theme().background
                                                            } else {
                                                                muted
                                                            }),
                                                        )
                                                        .on_click(cx.listener(
                                                            move |this, _, window, cx| {
                                                                if this.busy {
                                                                    this.stop_turn(cx);
                                                                    return;
                                                                }
                                                                if this.accept_slash_if_open(
                                                                    window, cx,
                                                                ) {
                                                                    return;
                                                                }
                                                                let text = this
                                                                    .input
                                                                    .read(cx)
                                                                    .value()
                                                                    .to_string();
                                                                if !text.trim().is_empty() {
                                                                    this.input.update(cx, |i, cx| {
                                                                        i.set_value("", window, cx);
                                                                    });
                                                                    this.send(text, cx);
                                                                }
                                                            },
                                                        ))
                                                }),
                                        ),
                                )
                                .child(
                                    // Meta row under the pill: context chips and status.
                                    h_flex()
                                        .w_full()
                                        .items_center()
                                        .gap_2()
                                        .px_1()
                                        .child(
                                            h_flex()
                                                .flex_1()
                                                .min_w_0()
                                                .items_center()
                                                .gap_1()
                                                .when_some(branch, |row, branch| {
                                                    let entity = entity.clone();
                                                    let root = self.workspace_root();
                                                    row.child(
                                                        Button::new("agent-branch-chip")
                                                            .ghost()
                                                            .xsmall()
                                                            .label(branch.clone())
                                                            .icon(
                                                                gpui_kit::assets::IconName::GitBranch,
                                                            )
                                                            .dropdown_menu_with_anchor(
                                                                Anchor::TopLeft,
                                                                move |menu, _, _| {
                                                                    let root_copy = root.clone();
                                                                    let entity_copy = entity.clone();
                                                                    let entity_term = entity.clone();
                                                                    let branch_copy = branch.clone();
                                                                    menu.item(
                                                                        PopupMenuItem::new(
                                                                            "复制分支名",
                                                                        )
                                                                        .on_click(
                                                                            move |_, _, app| {
                                                                                app.write_to_clipboard(
                                                                                    gpui::ClipboardItem::new_string(
                                                                                        branch_copy.clone(),
                                                                                    ),
                                                                                );
                                                                            },
                                                                        ),
                                                                    )
                                                                    .item(
                                                                        PopupMenuItem::new(
                                                                            "打开仓库目录",
                                                                        )
                                                                        .on_click(
                                                                            move |_, _, app| {
                                                                                if let Some(root) =
                                                                                    root_copy.as_deref()
                                                                                {
                                                                                    let _ =
                                                                                        wb_host::open_ext::open_path(
                                                                                            std::path::Path::new(root),
                                                                                        );
                                                                                }
                                                                                let _ = &entity_copy;
                                                                                let _ = app;
                                                                            },
                                                                        ),
                                                                    )
                                                                    .item(
                                                                        PopupMenuItem::new(
                                                                            "新建终端",
                                                                        )
                                                                        .on_click(
                                                                            move |_, _, app| {
                                                                                if let Some(e) =
                                                                                    entity_term.upgrade()
                                                                                {
                                                                                    e.update(
                                                                                        app,
                                                                                        |this, cx| {
                                                                                            this.open_terminal(
                                                                                                cx,
                                                                                            );
                                                                                        },
                                                                                    );
                                                                                }
                                                                            },
                                                                        ),
                                                                    )
                                                                },
                                                            ),
                                                    )
                                                })
                                                .child({
                                                    let entity = entity.clone();
                                                    let workspaces = workspaces.clone();
                                                    let active_ws = active_ws.clone();
                                                    Button::new("agent-env-chip")
                                                        .ghost()
                                                        .xsmall()
                                                        .label(root_name.clone())
                                                        .icon(IconName::ChevronDown)
                                                        .dropdown_menu_with_anchor(
                                                            Anchor::TopLeft,
                                                            move |menu, _, _| {
                                                                let mut menu = menu;
                                                                for ws in &workspaces {
                                                                    let entity = entity.clone();
                                                                    let pick = ws.id.clone();
                                                                    menu = menu.item(
                                                                        PopupMenuItem::new(ws.title.clone())
                                                                            .checked(
                                                                                active_ws.as_deref()
                                                                                    == Some(pick.as_str()),
                                                                            )
                                                                            .on_click(move |_, _, app| {
                                                                                if let Some(e) = entity.upgrade() {
                                                                                    let pick = pick.clone();
                                                                                    e.update(app, |this, cx| {
                                                                                        this.set_thread_workspace(pick, cx);
                                                                                    });
                                                                                }
                                                                            }),
                                                                    );
                                                                }
                                                                let entity = entity.clone();
                                                                menu.separator().item(
                                                                    PopupMenuItem::new("添加工作区…").on_click(
                                                                        move |_, _, app| {
                                                                            if let Some(e) = entity.upgrade() {
                                                                                e.update(app, |this, cx| {
                                                                                    this.add_workspace(cx);
                                                                                });
                                                                            }
                                                                        },
                                                                    ),
                                                                )
                                                            },
                                                        )
                                                })
                                                .child({
                                                    let entity = entity.clone();
                                                    let current = thread_perm;
                                                    Button::new("agent-perm-chip")
                                                        .ghost()
                                                        .xsmall()
                                                        .label(format!("权限 · {perm_label}"))
                                                        .dropdown_menu_with_anchor(
                                                            Anchor::TopLeft,
                                                            move |menu, _, _| {
                                                                let mut menu = menu;
                                                                for mode in [
                                                                    wb_domain::AgentPermissionMode::Confirm,
                                                                    wb_domain::AgentPermissionMode::SessionAuto,
                                                                    wb_domain::AgentPermissionMode::Readonly,
                                                                ] {
                                                                    let entity = entity.clone();
                                                                    menu = menu.item(
                                                                        PopupMenuItem::new(
                                                                            permission_mode_label(mode),
                                                                        )
                                                                        .checked(current == mode)
                                                                        .on_click(move |_, _, app| {
                                                                            if let Some(e) = entity.upgrade() {
                                                                                e.update(app, |this, cx| {
                                                                                    this.set_thread_permission(mode, cx);
                                                                                });
                                                                            }
                                                                        }),
                                                                    );
                                                                }
                                                                menu
                                                            },
                                                        )
                                                })
                                                .child({
                                                    let entity = entity.clone();
                                                    let current = model_ref.clone();
                                                    Button::new("agent-model-chip")
                                                        .ghost()
                                                        .xsmall()
                                                        .label(format!("模型 · {model_label}"))
                                                        .dropdown_menu_with_anchor(
                                                            Anchor::TopLeft,
                                                            move |menu, _, _| {
                                                                let mut menu = menu;
                                                                for model in AgentPane::available_model_refs() {
                                                                    let entity = entity.clone();
                                                                    let pick = model.clone();
                                                                    menu = menu.item(
                                                                        PopupMenuItem::new(model_label_of(&model))
                                                                            .checked(current == model)
                                                                            .on_click(move |_, _, app| {
                                                                                if let Some(e) = entity.upgrade() {
                                                                                    let pick = pick.clone();
                                                                                    e.update(app, |this, cx| {
                                                                                        this.set_thread_model(pick, cx);
                                                                                    });
                                                                                }
                                                                            }),
                                                                    );
                                                                }
                                                                menu
                                                            },
                                                        )
                                                })
                                                .child(
                                                    h_flex()
                                                        .id("agent-slash-chip")
                                                        .items_center()
                                                        .gap_1()
                                                        .px_2()
                                                        .py_0p5()
                                                        .rounded(px(6.))
                                                        .border_1()
                                                        .border_color(border)
                                                        .text_xs()
                                                        .text_color(muted)
                                                        .cursor_pointer()
                                                        .hover(|s| s.text_color(accent))
                                                        .child("/命令")
                                                        .on_click(cx.listener(
                                                            |this, _, window, cx| {
                                                                let value = this
                                                                    .input
                                                                    .read(cx)
                                                                    .value()
                                                                    .to_string();
                                                                let next =
                                                                    if value.trim().is_empty() {
                                                                        "/".to_string()
                                                                    } else {
                                                                        format!("{value} /")
                                                                    };
                                                                let len = next.len();
                                                                this.input.update(
                                                                    cx,
                                                                    |state, cx| {
                                                                        state.set_value(
                                                                            &next, window, cx,
                                                                        );
                                                                        state.set_selected_range(
                                                                            len..len,
                                                                            cx,
                                                                        );
                                                                    },
                                                                );
                                                                window.focus(
                                                                    &this.input.focus_handle(cx),
                                                                    cx,
                                                                );
                                                                cx.notify();
                                                            },
                                                        )),
                                                )
                                                .when(draft_chars > 0, |row| {
                                                    row.child(
                                                        div()
                                                            .text_xs()
                                                            .text_color(muted)
                                                            .child(format!("{draft_chars} 字")),
                                                    )
                                                })
                                                .when(draft_chars == 0, |row| {
                                                    row.child(
                                                        h_flex()
                                                            .items_center()
                                                            .gap_1()
                                                            .child(
                                                                div()
                                                                    .px_1()
                                                                    .rounded(px(3.))
                                                                    .bg(border)
                                                                    .text_xs()
                                                                    .text_color(muted)
                                                                    .child("Enter"),
                                                            )
                                                            .child(
                                                                div()
                                                                    .text_xs()
                                                                    .text_color(muted)
                                                                    .child("发送"),
                                                            ),
                                                    )
                                                }),
                                        )
                                        .child(
                                            h_flex()
                                                .items_center()
                                                .gap_1()
                                                .flex_shrink_0()
                                                .child(
                                                    h_flex()
                                                        .id("agent-preview-toggle")
                                                        .items_center()
                                                        .gap_1()
                                                        .px_1p5()
                                                        .py_0p5()
                                                        .rounded(px(6.))
                                                        .text_xs()
                                                        .text_color(if self.composer_preview {
                                                            accent
                                                        } else {
                                                            muted
                                                        })
                                                        .cursor_pointer()
                                                        .hover(|s| s.bg(border))
                                                        .child(if self.composer_preview {
                                                            "预览开"
                                                        } else {
                                                            "预览"
                                                        })
                                                        .on_click(cx.listener(
                                                            |this, _, window, cx| {
                                                                this.composer_preview =
                                                                    !this.composer_preview;
                                                                window.focus(
                                                                    &this.input.focus_handle(cx),
                                                                    cx,
                                                                );
                                                                cx.notify();
                                                            },
                                                        )),
                                                ),
                                        ),
                                )
                                .into_any_element()
                        },
                    ),
            )
            .into_any_element()
    }
}

/// Colours shared by every chat row, gathered so the render helpers keep a
/// readable signature instead of eight theme arguments.
#[derive(Clone)]
struct ChatPalette {
    radius: Pixels,
    muted: Hsla,
    accent: Hsla,
    secondary: Hsla,
    success: Hsla,
    danger: Hsla,
    /// Workspace root, used to resolve relative paths in tool results.
    workspace_root: Option<String>,
}

fn render_chat_message(
    m: &AgentMessage,
    expanded_tools: &HashSet<String>,
    palette: ChatPalette,
    entity: WeakEntity<AgentPane>,
) -> AnyElement {
    let ChatPalette {
        radius,
        muted,
        accent,
        secondary,
        success: cx_success,
        danger,
        ..
    } = palette.clone();
    let patch_palette = palette.clone();
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
    let is_assistant = matches!(m.role, AgentRole::Assistant);
    let is_tool = matches!(m.role, AgentRole::Tool);
    let expanded = expanded_tools.contains(&msg_id);
    let patch_card = is_tool
        .then(|| {
            let root = patch_palette.workspace_root.clone();
            render_patch_card(&content, expanded, &msg_id, patch_palette, root, &entity)
        })
        .flatten();
    let body = if let Some(card) = patch_card {
        card
    } else if is_tool && !expanded {
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
        let block_id = msg_id.clone();
        TextView::markdown(SharedString::from(format!("msg-{msg_id}")), content.clone())
            .code_block_actions(move |code_block, _window, _cx| {
                h_flex().gap_1().child(
                    Clipboard::new(SharedString::from(format!("copy-block-{block_id}")))
                        .value(code_block.code()),
                )
            })
            .into_any_element()
    } else {
        div().text_sm().child(content.clone()).into_any_element()
    };
    let copy_id = format!("copy-{msg_id}");
    let clock = format_local_clock(m.created_at);
    // Tool results get a coloured dot: green when the call succeeded, red when it
    // failed, so a long transcript can be scanned without expanding each row.
    let tool_state = is_tool.then(|| {
        if m.is_tool_error() {
            ("失败", danger)
        } else {
            ("成功", cx_success)
        }
    });
    let header = h_flex()
        .w_full()
        .items_center()
        .gap_2()
        .when_some(tool_state, |row, (label, color)| {
            row.child(
                h_flex()
                    .gap_1()
                    .items_center()
                    .child(div().size(px(6.)).rounded_full().bg(color))
                    .child(div().text_xs().text_color(color).child(label)),
            )
        })
        .child(
            div()
                .text_xs()
                .font_bold()
                .text_color(muted)
                .child(role.to_string()),
        )
        .child(div().text_xs().text_color(muted).child(clock))
        .when_some(m.duration_ms, |row, ms| {
            // Fast calls read better in ms; anything past a second in seconds.
            let label = if ms < 1_000 {
                format!("{ms} ms")
            } else {
                format!("{:.1} s", ms as f64 / 1000.0)
            };
            row.child(div().text_xs().text_color(muted).child(label))
        })
        .when(
            is_assistant && !content.contains("模型请求失败"),
            |row| {
                let entity = entity.clone();
                let regen_id = msg_id.clone();
                row.child(
                    Button::new(SharedString::from(format!("msg-regen-{regen_id}")))
                        .xsmall()
                        .ghost()
                        .label("重新生成")
                        .on_click(move |_, _, app| {
                            if let Some(e) = entity.upgrade() {
                                e.update(app, |this, cx| {
                                    this.regenerate_from(regen_id.clone(), cx)
                                });
                            }
                        }),
                )
            },
        )
        .when(
            matches!(m.role, AgentRole::Assistant) && content.contains("模型请求失败"),
            |row| {
                let entity = entity.clone();
                row.child(
                    Button::new(SharedString::from(format!("msg-retry-{msg_id}")))
                        .xsmall()
                        .ghost()
                        .label("重试")
                        .on_click(move |_, _, app| {
                            if let Some(e) = entity.upgrade() {
                                e.update(app, |this, cx| this.retry_last_user(cx));
                            }
                        }),
                )
            },
        )
        .when(is_tool, |row| {
            let tid = msg_id.clone();
            let exp_entity = entity.clone();
            let quote_entity = entity.clone();
            let quote_tid = msg_id.clone();
            row.child(
                Button::new(SharedString::from(format!("tool-exp-{tid}")))
                    .xsmall()
                    .ghost()
                    .label(if expanded { "收起" } else { "展开" })
                    .on_click(move |_, _, app| {
                        if let Some(e) = exp_entity.upgrade() {
                            e.update(app, |this, cx| this.toggle_tool_expand(tid.clone(), cx));
                        }
                    }),
            )
            .child({
                // Pull a tool result into the composer instead of retyping it.
                let body = content.clone();
                Button::new(SharedString::from(format!("tool-quote-{quote_tid}")))
                    .xsmall()
                    .ghost()
                    .label("引用")
                    .on_click(move |_, _, app| {
                        if let Some(e) = quote_entity.upgrade() {
                            let body = body.clone();
                            e.update(app, |this, cx| {
                                this.quote_into_composer(&body, cx);
                            });
                        }
                    })
            })
        })
        .when(is_user, |row| {
            let edit_mid = msg_id.clone();
            let edit_entity = entity.clone();
            let resend_mid = msg_id.clone();
            let resend_entity = entity.clone();
            row.child(
                Button::new(SharedString::from(format!("msg-edit-{edit_mid}")))
                    .xsmall()
                    .ghost()
                    .label("编辑")
                    .on_click(move |_, _, app| {
                        if let Some(e) = edit_entity.upgrade() {
                            e.update(app, |this, cx| {
                                this.edit_message(&edit_mid, cx);
                            });
                        }
                    }),
            )
            .child(
                Button::new(SharedString::from(format!("msg-resend-{resend_mid}")))
                    .xsmall()
                    .ghost()
                    .label("重发")
                    .on_click(move |_, _, app| {
                        if let Some(e) = resend_entity.upgrade() {
                            e.update(app, |this, cx| {
                                this.resend_message(&resend_mid, cx);
                            });
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

fn day_marker(day: &str, muted: Hsla, created_at: i64) -> AnyElement {
    let _ = day;
    div()
        .w_full()
        .py_2()
        .flex()
        .justify_center()
        .child(
            div()
                .text_xs()
                .font_bold()
                .text_color(muted)
                .child(format_chat_day_label(created_at)),
        )
        .into_any_element()
}

/// Consecutive tool results collapse into one row; expanding shows each result.
fn flush_tool_group(
    group: Vec<AgentMessage>,
    day: &str,
    last_day: &mut String,
    expanded_tools: &HashSet<String>,
    palette: ChatPalette,
    entity: WeakEntity<AgentPane>,
) -> Vec<AnyElement> {
    let muted = palette.muted;
    let radius = palette.radius;
    let secondary = palette.secondary;
    let mut rows = Vec::new();
    if day != last_day {
        *last_day = day.to_string();
        rows.push(day_marker(day, muted, group[0].created_at));
    }
    if group.len() == 1 {
        rows.push(render_chat_message(
            &group[0],
            expanded_tools,
            palette.clone(),
            entity,
        ));
        return rows;
    }

    let names: Vec<String> = {
        let mut seen: Vec<String> = Vec::new();
        for m in &group {
            let name = m.tool_name.clone().unwrap_or_else(|| "tool".into());
            if !seen.contains(&name) {
                seen.push(name);
            }
        }
        seen
    };
    let group_id = format!("tool-group-{}", group[0].id);
    let expanded = expanded_tools.contains(&group_id);
    let body: Vec<AnyElement> = if expanded {
        group
            .iter()
            .map(|m| render_chat_message(m, expanded_tools, palette.clone(), entity.clone()))
            .collect()
    } else {
        Vec::new()
    };
    let toggle_id = group_id.clone();
    let toggle_entity = entity;
    let summary = format!("{} 次工具调用 · {}", group.len(), names.join(" · "));
    rows.push(
        v_flex()
            .w_full()
            .gap_1()
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap_2()
                    .p_2()
                    .rounded(radius)
                    .bg(secondary)
                    .child(div().flex_1().text_xs().text_color(muted).child(summary))
                    .child(
                        Button::new(SharedString::from(format!("tool-group-exp-{group_id}")))
                            .xsmall()
                            .ghost()
                            .label(if expanded { "收起" } else { "展开" })
                            .on_click(move |_, _, app| {
                                if let Some(e) = toggle_entity.upgrade() {
                                    e.update(app, |this, cx| {
                                        this.toggle_tool_expand(toggle_id.clone(), cx)
                                    });
                                }
                            }),
                    ),
            )
            .children(body)
            .into_any_element(),
    );
    rows
}

/// Read the integer that follows `label` in a summary string, e.g. `修改 3（2 处）`.
fn count_before(text: &str, label: &str) -> usize {
    crate::tool_summary::count_after(text, label)
}

/// Summary line + per-file list for an `apply_patch` tool result.
fn render_patch_card(
    content: &str,
    expanded: bool,
    msg_id: &str,
    palette: ChatPalette,
    root: Option<String>,
    entity: &WeakEntity<AgentPane>,
) -> Option<AnyElement> {
    let muted = palette.muted;
    let accent = palette.accent;
    let secondary = palette.secondary;
    let danger_color = palette.danger;
    let rest = content.strip_prefix("已应用补丁：")?;
    let mut lines = rest.lines();
    let head = lines.next().unwrap_or("").trim().to_string();
    // `新增 2 · 修改 1（3 处）· 删除 1` → per-file counts for the badge row.
    let added_count = count_before(&head, "新增");
    let updated_count = count_before(&head, "修改");
    let removed_count = count_before(&head, "删除");
    let files: Vec<String> = lines
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    if files.is_empty() {
        return None;
    }
    let shown: Vec<String> = if expanded {
        files.clone()
    } else {
        files.iter().take(4).cloned().collect()
    };
    let hidden = files.len().saturating_sub(shown.len());
    let tid = msg_id.to_string();
    let toggle_entity = entity.clone();

    Some(
        v_flex()
            .gap_1()
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        div()
                            .text_xs()
                            .font_bold()
                            .text_color(accent)
                            .child("补丁已应用"),
                    )
                    .child(div().text_xs().text_color(muted).child(head))
                    .when(added_count > 0, |row| {
                        row.child(
                            div()
                                .text_xs()
                                .text_color(accent)
                                .child(format!("+{added_count} 文件")),
                        )
                    })
                    .when(updated_count > 0, |row| {
                        row.child(
                            div()
                                .text_xs()
                                .text_color(muted)
                                .child(format!("~{updated_count} 文件")),
                        )
                    })
                    .when(removed_count > 0, |row| {
                        row.child(
                            div()
                                .text_xs()
                                .text_color(danger_color)
                                .child(format!("−{removed_count} 文件")),
                        )
                    })
                    .when(files.len() > 4, |row| {
                        row.child(
                            Button::new(SharedString::from(format!("patch-exp-{tid}")))
                                .xsmall()
                                .ghost()
                                .label(if expanded { "收起" } else { "全部文件" })
                                .on_click(move |_, _, app| {
                                    if let Some(e) = toggle_entity.upgrade() {
                                        e.update(app, |this, cx| {
                                            this.toggle_tool_expand(tid.clone(), cx)
                                        });
                                    }
                                }),
                        )
                    }),
            )
            .children(shown.into_iter().enumerate().map(|(ix, line)| {
                let color = if line.starts_with('+') { accent } else { muted };
                // Strip the leading `+ ` / `~ ` / `- ` marker to get the path.
                let path = line
                    .split_once(' ')
                    .map(|(_, rest)| rest.trim().to_string())
                    .unwrap_or_else(|| line.clone());
                let path = path.split('（').next().unwrap_or(&path).trim().to_string();
                let click_root = root.clone();
                let click_path = path.clone();
                let clickable = click_root.is_some() && !click_path.is_empty();
                div()
                    .id(SharedString::from(format!("patch-file-{msg_id}-{ix}")))
                    .text_xs()
                    .text_color(color)
                    .when(clickable, |el| {
                        el.cursor_pointer()
                            .hover(|s| s.underline())
                            .on_click(move |_, _, _| {
                                if let Some(root) = click_root.as_deref() {
                                    let full = std::path::Path::new(root).join(&click_path);
                                    if let Err(e) = wb_host::open_path(&full) {
                                        log::warn!("打开 {} 失败: {e}", full.display());
                                    }
                                }
                            })
                    })
                    .child(line)
            }))
            .when(hidden > 0, |col| {
                col.child(
                    div()
                        .text_xs()
                        .text_color(muted)
                        .child(format!("…还有 {hidden} 个文件")),
                )
            })
            .bg(secondary.opacity(0.6))
            .rounded(px(6.))
            .p_2()
            .into_any_element(),
    )
}
