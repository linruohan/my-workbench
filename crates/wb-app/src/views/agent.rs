use crate::state::AppState;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use wb_agent::{create_thread, run_user_turn};
use wb_domain::{AgentRole, AgentWorkspace, agent_workspace_title_from_path, create_id, now_ms};
use wb_host::pick_directory;

pub struct AgentPane {
    state: AppState,
    input: Entity<InputState>,
    busy: bool,
    status: String,
    _subs: Vec<Subscription>,
}

impl AgentPane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input =
            cx.new(|cx| InputState::new(window, cx).placeholder("给 Agent 发消息，或 /task_list"));
        let mut this = Self {
            state,
            input: input.clone(),
            busy: false,
            status: String::new(),
            _subs: Vec::new(),
        };
        this._subs.push(
            cx.subscribe_in(&input, window, |this, input, event, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    if this.busy {
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
            }),
        );
        this
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
        let thread_id = self.ensure_thread();
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

        self.busy = true;
        self.status.clear();
        cx.notify();

        let result = self.state.with_mut(|s| {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            rt.block_on(run_user_turn(&mut s.repo, &thread, &text, proxy.as_deref()))
        });

        match result {
            Ok(_) => self.status.clear(),
            Err(e) => self.status = e.to_string(),
        }
        self.state.persist_if_dirty();
        self.busy = false;
        cx.notify();
    }

    fn add_workspace(&mut self, cx: &mut Context<Self>) {
        if let Some(dir) = pick_directory() {
            let path = dir.to_string_lossy().to_string();
            let title = agent_workspace_title_from_path(&path);
            let now = now_ms();
            let ws = AgentWorkspace {
                id: create_id(now),
                title,
                root_path: Some(path),
                created_at: now,
                updated_at: now,
            };
            self.state.with_mut(|s| s.repo.upsert_agent_workspace(ws));
            self.state.persist_if_dirty();
            cx.notify();
        }
    }

    fn new_thread(&mut self, cx: &mut Context<Self>) {
        self.state.with_mut(|s| s.active_thread_id = None);
        let _ = self.ensure_thread();
        self.state.persist_if_dirty();
        cx.notify();
    }
}

impl Render for AgentPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (threads, messages, workspaces) = self.state.with(|s| {
            let tid = s.active_thread_id.clone();
            let messages = tid
                .as_deref()
                .map(|id| s.repo.messages_for_thread(id))
                .unwrap_or_default();
            (
                s.repo.list_agent_threads(),
                messages,
                s.repo.list_agent_workspaces(),
            )
        });
        let entity = cx.weak_entity();
        let active = self.state.with(|s| s.active_thread_id.clone());
        let status = self.status.clone();

        h_flex()
            .size_full()
            .child(
                v_flex()
                    .w(px(240.))
                    .h_full()
                    .border_r_1()
                    .border_color(cx.theme().border)
                    .p_3()
                    .gap_2()
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("agent-new")
                                    .small()
                                    .primary()
                                    .label("新会话")
                                    .on_click(cx.listener(|this, _, _, cx| this.new_thread(cx))),
                            )
                            .child(
                                Button::new("agent-ws")
                                    .small()
                                    .label("工作区")
                                    .on_click(cx.listener(|this, _, _, cx| this.add_workspace(cx))),
                            ),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!("{} 个工作区", workspaces.len())),
                    )
                    .child(v_flex().gap_1().children(threads.into_iter().map(|t| {
                        let id = t.id.clone();
                        let selected = active.as_deref() == Some(id.as_str());
                        let entity = entity.clone();
                        div()
                            .id(SharedString::from(format!("thread-{id}")))
                            .p_2()
                            .rounded(cx.theme().radius)
                            .when(selected, |d| d.bg(cx.theme().accent))
                            .hover(|d| d.bg(cx.theme().accent.opacity(0.5)))
                            .cursor_pointer()
                            .child(t.title)
                            .on_click(move |_, _, app| {
                                if let Some(e) = entity.upgrade() {
                                    e.update(app, |this, cx| {
                                        this.state
                                            .with_mut(|s| s.active_thread_id = Some(id.clone()));
                                        cx.notify();
                                    });
                                }
                            })
                    }))),
            )
            .child(
                v_flex()
                    .flex_1()
                    .h_full()
                    .p_3()
                    .gap_2()
                    .child(v_flex().flex_1().gap_2().overflow_hidden().children(
                        messages.into_iter().map(|m| {
                            let role = match m.role {
                                AgentRole::User => "你",
                                AgentRole::Assistant => "Agent",
                                AgentRole::Tool => m.tool_name.as_deref().unwrap_or("tool"),
                                AgentRole::System => "系统",
                            };
                            v_flex()
                                .gap_1()
                                .p_2()
                                .rounded(cx.theme().radius)
                                .bg(cx.theme().secondary)
                                .child(
                                    div()
                                        .text_xs()
                                        .font_bold()
                                        .text_color(cx.theme().muted_foreground)
                                        .child(role.to_string()),
                                )
                                .child(div().child(m.content))
                        }),
                    ))
                    .when(!status.is_empty(), |col| {
                        col.child(div().text_sm().text_color(cx.theme().danger).child(status))
                    })
                    .child(
                        h_flex().gap_2().child(Input::new(&self.input)).child(
                            Button::new("send")
                                .primary()
                                .label(if self.busy { "…" } else { "发送" })
                                .disabled(self.busy)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    let text = this.input.read(cx).value().to_string();
                                    if !text.trim().is_empty() {
                                        this.input.update(cx, |i, cx| {
                                            i.set_value("", window, cx);
                                        });
                                        this.send(text, cx);
                                    }
                                })),
                        ),
                    ),
            )
    }
}
