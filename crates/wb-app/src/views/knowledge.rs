use crate::state::AppState;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::text::TextView;
use gpui_kit::component::{Selectable as _, *};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::path::PathBuf;
use wb_host::{
    create_markdown, git_branch, list_files_recursive, open_path, pick_directory, read_text,
    write_text,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum KbMode {
    /// 实时编辑（与源码同编辑器，保留三态入口）
    #[default]
    Live,
    Source,
    Preview,
}

pub struct KnowledgePane {
    state: AppState,
    files: Vec<(String, String)>,
    editor: Entity<InputState>,
    find: Entity<InputState>,
    replace: Entity<InputState>,
    current: Option<String>,
    filter: Entity<InputState>,
    mode: KbMode,
    replace_status: String,
    _subs: Vec<Subscription>,
}

impl KnowledgePane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(|cx| InputState::new(window, cx).placeholder("选择文件开始编辑…"));
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("筛选文件名"));
        let find = cx.new(|cx| InputState::new(window, cx).placeholder("查找"));
        let replace = cx.new(|cx| InputState::new(window, cx).placeholder("替换为"));
        let mut this = Self {
            state,
            files: Vec::new(),
            editor: editor.clone(),
            find,
            replace,
            current: None,
            filter,
            mode: KbMode::Live,
            replace_status: String::new(),
            _subs: Vec::new(),
        };
        this.reload_files();
        this._subs.push(
            cx.subscribe_in(&editor, window, |this, input, event, _window, cx| {
                if matches!(event, InputEvent::Blur) {
                    let text = input.read(cx).value().to_string();
                    this.save_current(&text);
                }
            }),
        );
        this
    }

    fn root(&self) -> Option<PathBuf> {
        self.state.with(|s| {
            s.prefs
                .knowledge_current
                .clone()
                .or_else(|| s.prefs.knowledge_roots.first().cloned())
                .map(PathBuf::from)
        })
    }

    fn reload_files(&mut self) {
        self.files.clear();
        if let Some(root) = self.root() {
            if let Ok(entries) = list_files_recursive(&root, 2000) {
                self.files = entries.into_iter().map(|e| (e.path, e.relative)).collect();
            }
        }
    }

    fn add_root(&mut self, cx: &mut Context<Self>) {
        if let Some(dir) = pick_directory() {
            let path = dir.to_string_lossy().to_string();
            self.state.with_mut(|s| {
                if !s.prefs.knowledge_roots.contains(&path) {
                    s.prefs.knowledge_roots.push(path.clone());
                }
                s.prefs.knowledge_current = Some(path.clone());
                s.prefs.knowledge_recent.retain(|p| p != &path);
                s.prefs.knowledge_recent.insert(0, path);
                s.prefs.knowledge_recent.truncate(10);
            });
            self.state.persist_prefs();
            self.reload_files();
            cx.notify();
        }
    }

    fn open_file(&mut self, path: &str, window: &mut Window, cx: &mut Context<Self>) {
        match read_text(std::path::Path::new(path)) {
            Ok(text) => {
                self.current = Some(path.to_string());
                self.state
                    .with_mut(|s| s.kb_current_file = Some(path.to_string()));
                self.editor.update(cx, |input, cx| {
                    input.set_value(text, window, cx);
                });
                self.replace_status.clear();
                cx.notify();
            }
            Err(e) => log::warn!("打开文件失败: {e}"),
        }
    }

    fn save_current(&mut self, text: &str) {
        let Some(path) = self.current.clone() else {
            return;
        };
        if let Err(e) = write_text(std::path::Path::new(&path), text) {
            log::warn!("保存失败: {e}");
        }
    }

    fn new_md(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(root) = self.root() else {
            return;
        };
        match create_markdown(&root, "未命名") {
            Ok(path) => {
                self.reload_files();
                self.open_file(&path.to_string_lossy(), window, cx);
            }
            Err(e) => log::warn!("{e}"),
        }
    }

    fn find_next(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let needle = self.find.read(cx).value().to_string();
        if needle.is_empty() {
            self.replace_status = "请输入查找内容".into();
            cx.notify();
            return;
        }
        let text = self.editor.read(cx).value().to_string();
        let count = text.matches(&needle).count();
        self.replace_status = if count == 0 {
            "未找到".into()
        } else {
            format!("共 {count} 处")
        };
        // Focus editor so user can continue editing near the match.
        let _ = window;
        cx.notify();
    }

    fn replace_once(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let needle = self.find.read(cx).value().to_string();
        let replacement = self.replace.read(cx).value().to_string();
        if needle.is_empty() {
            self.replace_status = "请输入查找内容".into();
            cx.notify();
            return;
        }
        let text = self.editor.read(cx).value().to_string();
        if !text.contains(&needle) {
            self.replace_status = "未找到".into();
            cx.notify();
            return;
        }
        let next = text.replacen(&needle, &replacement, 1);
        self.editor.update(cx, |input, cx| {
            input.set_value(&next, window, cx);
        });
        self.save_current(&next);
        self.replace_status = "已替换 1 处".into();
        cx.notify();
    }

    fn replace_all(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let needle = self.find.read(cx).value().to_string();
        let replacement = self.replace.read(cx).value().to_string();
        if needle.is_empty() {
            self.replace_status = "请输入查找内容".into();
            cx.notify();
            return;
        }
        let text = self.editor.read(cx).value().to_string();
        let count = text.matches(&needle).count();
        if count == 0 {
            self.replace_status = "未找到".into();
            cx.notify();
            return;
        }
        let next = text.replace(&needle, &replacement);
        self.editor.update(cx, |input, cx| {
            input.set_value(&next, window, cx);
        });
        self.save_current(&next);
        self.replace_status = format!("已全部替换 {count} 处");
        cx.notify();
    }
}

impl Render for KnowledgePane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let pending = self.state.with(|s| s.kb_current_file.clone());
        if let Some(path) = pending {
            if self.current.as_deref() != Some(path.as_str()) {
                self.open_file(&path, window, cx);
            }
        }
        let filter = self.filter.read(cx).value().to_lowercase();
        let files: Vec<_> = self
            .files
            .iter()
            .filter(|(_, rel)| filter.is_empty() || rel.to_lowercase().contains(&filter))
            .cloned()
            .collect();
        let root_label = self
            .root()
            .map(|p| {
                let path = p.to_string_lossy().to_string();
                match git_branch(&p) {
                    Some(branch) => format!("{path}  ·  {branch}"),
                    None => path,
                }
            })
            .unwrap_or_else(|| "未选择知识库".into());
        let entity = cx.weak_entity();
        let current = self.current.clone();
        let preview_text = self.editor.read(cx).value().to_string();
        let mode = self.mode;
        let replace_status = self.replace_status.clone();
        let muted = cx.theme().muted_foreground;
        let border = cx.theme().border;
        let radius = cx.theme().radius;

        h_flex()
            .size_full()
            .child(
                v_flex()
                    .w(px(280.))
                    .h_full()
                    .border_r_1()
                    .border_color(border)
                    .p_3()
                    .gap_2()
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("kb-add")
                                    .small()
                                    .label("添加库")
                                    .on_click(cx.listener(|this, _, _, cx| this.add_root(cx))),
                            )
                            .child(
                                Button::new("kb-new")
                                    .small()
                                    .primary()
                                    .label("新建 MD")
                                    .on_click(
                                        cx.listener(|this, _, window, cx| this.new_md(window, cx)),
                                    ),
                            ),
                    )
                    .child(div().text_xs().text_color(muted).child(root_label))
                    .child(Input::new(&self.filter).cleanable(true))
                    .child(v_flex().gap_1().flex_1().overflow_y_scrollbar().children(
                        files.into_iter().map(|(path, rel)| {
                            let active = current.as_deref() == Some(path.as_str());
                            let entity = entity.clone();
                            div()
                                .id(SharedString::from(path.clone()))
                                .p_2()
                                .rounded(radius)
                                .when(active, |d| d.bg(cx.theme().accent))
                                .hover(|d| d.bg(cx.theme().accent))
                                .cursor_pointer()
                                .child(rel)
                                .on_click(move |_, window, app| {
                                    if let Some(e) = entity.upgrade() {
                                        e.update(app, |this, cx| {
                                            this.open_file(&path, window, cx);
                                        });
                                    }
                                })
                        }),
                    )),
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
                            .child(
                                Button::new("kb-live")
                                    .small()
                                    .label("实时")
                                    .selected(mode == KbMode::Live)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.mode = KbMode::Live;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                Button::new("kb-source")
                                    .small()
                                    .label("源码")
                                    .selected(mode == KbMode::Source)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.mode = KbMode::Source;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                Button::new("kb-preview")
                                    .small()
                                    .label("预览")
                                    .selected(mode == KbMode::Preview)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        let text = this.editor.read(cx).value().to_string();
                                        this.save_current(&text);
                                        this.mode = KbMode::Preview;
                                        cx.notify();
                                    })),
                            )
                            .when(current.is_some(), |row| {
                                let path = current.clone().unwrap();
                                row.child(
                                    Button::new("kb-reveal")
                                        .small()
                                        .ghost()
                                        .label("打开位置")
                                        .on_click(move |_, _, _| {
                                            let p = std::path::Path::new(&path);
                                            let target = p.parent().unwrap_or(p);
                                            let _ = open_path(target);
                                        }),
                                )
                            }),
                    )
                    .when(
                        matches!(mode, KbMode::Live | KbMode::Source) && current.is_some(),
                        |col| {
                            col.child(
                                h_flex()
                                    .gap_2()
                                    .flex_wrap()
                                    .items_center()
                                    .child(Input::new(&self.find).cleanable(true))
                                    .child(Input::new(&self.replace).cleanable(true))
                                    .child(Button::new("kb-find").xsmall().label("查找").on_click(
                                        cx.listener(|this, _, window, cx| {
                                            this.find_next(window, cx);
                                        }),
                                    ))
                                    .child(Button::new("kb-repl").xsmall().label("替换").on_click(
                                        cx.listener(|this, _, window, cx| {
                                            this.replace_once(window, cx);
                                        }),
                                    ))
                                    .child(
                                        Button::new("kb-repl-all")
                                            .xsmall()
                                            .primary()
                                            .label("全部替换")
                                            .on_click(cx.listener(|this, _, window, cx| {
                                                this.replace_all(window, cx);
                                            })),
                                    )
                                    .when(!replace_status.is_empty(), |row| {
                                        row.child(
                                            div()
                                                .text_xs()
                                                .text_color(muted)
                                                .child(replace_status.clone()),
                                        )
                                    }),
                            )
                        },
                    )
                    .child(match mode {
                        KbMode::Live | KbMode::Source => {
                            Input::new(&self.editor).into_any_element()
                        }
                        KbMode::Preview => div()
                            .flex_1()
                            .w_full()
                            .overflow_y_scrollbar()
                            .child(TextView::markdown("kb-preview", preview_text))
                            .into_any_element(),
                    }),
            )
    }
}
