use crate::state::AppState;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::text::TextView;
use gpui_kit::component::{Disableable as _, *};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use wb_agent::{begin_user_turn, create_thread, finish_user_turn, resolve_turn_reply};
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
        if self.busy {
            return;
        }
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

        let pending = self
            .state
            .with_mut(|s| begin_user_turn(&mut s.repo, &thread, &text));
        self.state.persist_if_dirty();

        self.busy = true;
        self.status.clear();
        cx.notify();

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
                this.state.with_mut(|s| {
                    finish_user_turn(&mut s.repo, &pending, reply);
                });
                this.state.persist_if_dirty();
                this.status.clear();
                this.busy = false;
                cx.notify();
            })
            .ok();
        })
        .detach();
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

    fn delete_thread(&mut self, id: &str, cx: &mut Context<Self>) {
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
        self.state.with_mut(|s| s.active_thread_id = Some(id));
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
        let radius = cx.theme().radius;
        let muted = cx.theme().muted_foreground;
        let accent = cx.theme().accent;
        let secondary = cx.theme().secondary;
        let border = cx.theme().border;
        let danger = cx.theme().danger;

        let thread_rows: Vec<_> = threads
            .into_iter()
            .map(|t| {
                let id = t.id.clone();
                let selected = active.as_deref() == Some(id.as_str());
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
                            .child(t.title)
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
                        Button::new(SharedString::from(format!("del-thread-{id}")))
                            .xsmall()
                            .ghost()
                            .label("×")
                            .on_click({
                                let id = id.clone();
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

        let message_rows: Vec<_> = messages
            .into_iter()
            .map(|m| {
                let role = match m.role {
                    AgentRole::User => "你",
                    AgentRole::Assistant => "Agent",
                    AgentRole::Tool => m.tool_name.as_deref().unwrap_or("tool"),
                    AgentRole::System => "系统",
                };
                let content = m.content.clone();
                let use_md = matches!(m.role, AgentRole::Assistant | AgentRole::System);
                let msg_id = m.id.clone();
                v_flex()
                    .gap_1()
                    .p_2()
                    .rounded(radius)
                    .bg(secondary)
                    .child(
                        div()
                            .text_xs()
                            .font_bold()
                            .text_color(muted)
                            .child(role.to_string()),
                    )
                    .child(if use_md {
                        TextView::markdown(SharedString::from(format!("msg-{msg_id}")), content)
                            .into_any_element()
                    } else {
                        div().child(content).into_any_element()
                    })
                    .into_any_element()
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
                            .text_color(muted)
                            .child(format!("{} 个工作区", workspaces.len())),
                    )
                    .child(
                        v_flex()
                            .gap_1()
                            .flex_1()
                            .overflow_y_scrollbar()
                            .children(thread_rows),
                    ),
            )
            .child(
                v_flex()
                    .flex_1()
                    .h_full()
                    .p_3()
                    .gap_2()
                    .child(
                        v_flex()
                            .flex_1()
                            .gap_2()
                            .overflow_y_scrollbar()
                            .children(message_rows),
                    )
                    .when(!status.is_empty(), |col| {
                        col.child(div().text_sm().text_color(danger).child(status))
                    })
                    .child(
                        h_flex().gap_2().flex_wrap().children(
                            ["/task_list", "/note_list", "/schedule_list"]
                                .into_iter()
                                .map(|cmd| {
                                    Button::new(SharedString::from(format!("slash-{cmd}")))
                                        .xsmall()
                                        .ghost()
                                        .label(cmd)
                                        .disabled(self.busy)
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            if this.busy {
                                                return;
                                            }
                                            this.input.update(cx, |i, cx| {
                                                i.set_value(cmd, window, cx);
                                            });
                                            this.send(cmd.to_string(), cx);
                                        }))
                                }),
                        ),
                    )
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
