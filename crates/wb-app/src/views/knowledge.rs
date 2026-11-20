use crate::state::AppState;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::text::TextView;
use gpui_kit::component::{Selectable as _, *};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::path::PathBuf;
use wb_host::{create_markdown, list_files_recursive, pick_directory, read_text, write_text};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum KbMode {
    #[default]
    Edit,
    Preview,
}

pub struct KnowledgePane {
    state: AppState,
    files: Vec<(String, String)>,
    editor: Entity<InputState>,
    current: Option<String>,
    filter: Entity<InputState>,
    mode: KbMode,
    _subs: Vec<Subscription>,
}

impl KnowledgePane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(|cx| InputState::new(window, cx).placeholder("选择文件开始编辑…"));
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("筛选文件名"));
        let mut this = Self {
            state,
            files: Vec::new(),
            editor: editor.clone(),
            current: None,
            filter,
            mode: KbMode::Edit,
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
}

impl Render for KnowledgePane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let filter = self.filter.read(cx).value().to_lowercase();
        let files: Vec<_> = self
            .files
            .iter()
            .filter(|(_, rel)| filter.is_empty() || rel.to_lowercase().contains(&filter))
            .cloned()
            .collect();
        let root_label = self
            .root()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "未选择知识库".into());
        let entity = cx.weak_entity();
        let current = self.current.clone();
        let preview_text = self.editor.read(cx).value().to_string();
        let mode = self.mode;

        h_flex()
            .size_full()
            .child(
                v_flex()
                    .w(px(280.))
                    .h_full()
                    .border_r_1()
                    .border_color(cx.theme().border)
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
                    .child(
                        div()
                            .text_xs()
                            .text_color(cx.theme().muted_foreground)
                            .child(root_label),
                    )
                    .child(Input::new(&self.filter).cleanable(true))
                    .child(v_flex().gap_1().flex_1().overflow_y_scrollbar().children(
                        files.into_iter().map(|(path, rel)| {
                            let active = current.as_deref() == Some(path.as_str());
                            let entity = entity.clone();
                            div()
                                .id(SharedString::from(path.clone()))
                                .p_2()
                                .rounded(cx.theme().radius)
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
                                Button::new("kb-edit")
                                    .small()
                                    .label("编辑")
                                    .selected(mode == KbMode::Edit)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.mode = KbMode::Edit;
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
                            ),
                    )
                    .child(match mode {
                        KbMode::Edit => Input::new(&self.editor).into_any_element(),
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
