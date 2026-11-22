use crate::state::AppState;
use gpui_kit::component::button::{Button, ButtonVariants as _, Toggle, ToggleVariants as _};
use gpui_kit::component::clipboard::Clipboard;
use gpui_kit::component::input::{Editor, EditorState, Input, InputEvent, InputState, TabSize};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::resizable::{h_resizable, resizable_panel};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::status_bar::StatusBar;
use gpui_kit::component::text::{
    FrontmatterPlugin, MarkdownExtensions, TaskToggleEvent, TextView, TextViewState, TextViewStyle,
};
use gpui_kit::component::{ActiveTheme as _, Icon, IconName, Selectable as _, Sizable as _, *};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
use wb_domain::{
    FindFlags, body_links_to, extract_wikilinks, find_spans, is_image_extension, resolve_wikilink,
};
use wb_host::{create_markdown, list_files_recursive, read_text, search_kb_content, write_text};

actions!(knowledge, [FindNote, CloseFind]);

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
    /// Absolute path and path relative to the library root.
    files: Vec<(String, String)>,
    /// Slash-separated directory keys that are expanded in the file tree.
    expanded: HashSet<String>,
    loaded_root: Option<String>,
    editor: Entity<EditorState>,
    preview: Entity<TextViewState>,
    find: Entity<InputState>,
    replace: Entity<InputState>,
    current: Option<String>,
    filter: Entity<InputState>,
    mode: KbMode,
    replace_status: String,
    preview_zoom: f32,
    table_wrap: bool,
    find_open: bool,
    find_word: bool,
    find_case: bool,
    find_regex: bool,
    last_editor_scroll_y: f32,
    last_preview_px: f32,
    _subs: Vec<Subscription>,
}

struct KbTreeNode {
    name: String,
    /// Slash-separated path from the library root.
    key: String,
    file_path: Option<String>,
    snippet: Option<String>,
    children: Vec<KbTreeNode>,
}

impl KnowledgePane {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(|cx| {
            EditorState::new(window, cx)
                .language("markdown")
                .line_number(true)
                .tab_size(TabSize {
                    tab_size: 2,
                    ..Default::default()
                })
                .searchable(false)
                .placeholder("选择文件开始编辑…")
        });
        let preview = cx.new(|cx| TextViewState::markdown("", cx));
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("筛选文件名或正文"));
        let find = cx.new(|cx| InputState::new(window, cx).placeholder("查找"));
        let replace = cx.new(|cx| InputState::new(window, cx).placeholder("替换为"));
        let mut this = Self {
            state,
            files: Vec::new(),
            expanded: HashSet::new(),
            loaded_root: None,
            editor: editor.clone(),
            preview,
            find,
            replace,
            current: None,
            filter,
            mode: KbMode::Live,
            replace_status: String::new(),
            preview_zoom: 1.0,
            table_wrap: false,
            find_open: false,
            find_word: false,
            find_case: false,
            find_regex: false,
            last_editor_scroll_y: 0.0,
            last_preview_px: 0.0,
            _subs: Vec::new(),
        };
        this.spawn_live_scroll_sync(cx);
        cx.bind_keys([
            KeyBinding::new("ctrl-f", FindNote, None),
            KeyBinding::new("escape", CloseFind, None),
        ]);
        this.reload_files();
        let last_note = this.state.with(|s| {
            if s.prefs.general.remember_last_note {
                s.prefs.general.last_note_path.clone()
            } else {
                None
            }
        });
        if let Some(path) = last_note.filter(|path| std::path::Path::new(path).is_file()) {
            this.open_file(&path, window, cx);
        }
        this._subs
            .push(cx.subscribe(&editor, |_, _, _: &InputEvent, cx| cx.notify()));
        this._subs.push(cx.subscribe_in(
            &this.find,
            window,
            |this, _, event, window, cx| match event {
                InputEvent::PressEnter { shift, .. } => {
                    if *shift {
                        this.find_prev(window, cx);
                    } else {
                        this.find_next(window, cx);
                    }
                }
                InputEvent::Change => this.sync_editor_search(cx),
                _ => {}
            },
        ));
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

    fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.find_open = true;
        self.sync_editor_search(cx);
        let handle = self.find.read(cx).focus_handle(cx).clone();
        handle.focus(window, cx);
        cx.notify();
    }

    fn close_find(&mut self, cx: &mut Context<Self>) {
        if self.find_open {
            self.find_open = false;
        }
        self.editor.update(cx, |editor, cx| editor.close_search(cx));
        cx.notify();
    }

    /// Highlight plain-text matches in the editor. Word and regex searches stay
    /// on the custom matcher, which the built-in highlighter does not cover.
    fn sync_editor_search(&mut self, cx: &mut Context<Self>) {
        let query = self.find.read(cx).value().to_string();
        let plain = self.find_open && !query.is_empty() && !self.find_word && !self.find_regex;
        if !plain {
            self.editor.update(cx, |editor, cx| editor.close_search(cx));
            return;
        }
        let case_insensitive = !self.find_case;
        self.editor.update(cx, |editor, cx| {
            editor.set_search_query(query, case_insensitive, cx)
        });
    }

    fn find_flags(&self) -> FindFlags {
        FindFlags {
            whole_word: self.find_word,
            match_case: self.find_case,
            regex: self.find_regex,
        }
    }

    fn library_label(&self) -> String {
        self.root()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "添加库".into())
    }

    fn current_file_name(&self) -> Option<String> {
        self.current.as_ref().and_then(|path| {
            Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
        })
    }

    fn sync_preview(&mut self, cx: &mut Context<Self>) {
        let source = self.editor.read(cx).value();
        let rendered = preview_markdown(source.as_str());
        self.preview.update(cx, |state, cx| {
            state.set_text(&rendered, cx);
        });
    }

    fn spawn_live_scroll_sync(&self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(32))
                    .await;
                if this
                    .update(cx, |pane, cx| pane.tick_live_scroll(cx))
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    fn tick_live_scroll(&mut self, cx: &mut Context<Self>) {
        if self.mode != KbMode::Live || self.current.is_none() {
            return;
        }
        let source = self.editor.read(cx).value().to_string();
        if source.is_empty() {
            return;
        }
        let Some(line_height) = self.editor.read(cx).line_height() else {
            return;
        };
        let line_h = f32::from(line_height);
        if line_h <= 0.0 {
            return;
        }

        let (editor_y, editor_min) = {
            let editor = self.editor.read(cx);
            let content_h = editor.content_height_f64();
            let view_h = f64::from(f32::from(editor.input_bounds().size.height));
            let min_y = (view_h - content_h).min(0.0);
            let y = editor.scroll_y_f64().clamp(min_y, 0.0);
            (y as f32, min_y as f32)
        };
        let (preview_px, preview_max) = {
            let list = self.preview.read(cx).list_state();
            let max = f32::from(list.max_offset_for_scrollbar().y).max(0.0);
            let y = (-f32::from(list.scroll_px_offset_for_scrollbar().y)).clamp(0.0, max);
            (y, max)
        };

        let de = (editor_y - self.last_editor_scroll_y).abs();
        let dp = (preview_px - self.last_preview_px).abs();
        if de < 1.0 && dp < 1.0 {
            return;
        }

        const END_PX: f32 = 4.0;
        let editor_at_end = editor_min < -1.0 && editor_y <= editor_min + END_PX;
        let preview_at_end = preview_max > 1.0 && preview_px >= preview_max - END_PX;

        if de >= dp {
            if editor_at_end {
                self.scroll_preview_to_px(preview_max, cx);
            } else {
                let editor_line = (-editor_y / line_h).max(0.0);
                let item = markdown_scroll_outline(&source).item_for_line(editor_line);
                self.scroll_preview_to_item(item, cx);
            }
            self.last_editor_scroll_y = editor_y;
            self.last_preview_px = self.preview_scroll_px(cx);
        } else if preview_at_end {
            self.editor.update(cx, |editor, cx| {
                editor.set_scroll_y_f64(editor_min as f64, cx);
            });
            self.last_preview_px = preview_px;
            self.last_editor_scroll_y = editor_min;
        } else {
            let preview_top = self.preview.read(cx).list_state().logical_scroll_top();
            let preview_item = preview_top.item_ix as f32
                + f32::from(preview_top.offset_in_item) / line_h.max(1.0);
            let line = markdown_scroll_outline(&source).line_for_item(preview_item);
            let y = (-(line * line_h)).clamp(editor_min, 0.0);
            self.editor.update(cx, |editor, cx| {
                editor.set_scroll_y_f64(y as f64, cx);
            });
            self.last_preview_px = preview_px;
            self.last_editor_scroll_y = y;
        }
    }

    fn preview_scroll_px(&self, cx: &App) -> f32 {
        let list = self.preview.read(cx).list_state();
        let max = f32::from(list.max_offset_for_scrollbar().y).max(0.0);
        (-f32::from(list.scroll_px_offset_for_scrollbar().y)).clamp(0.0, max)
    }

    fn scroll_preview_to_px(&self, px_down: f32, cx: &mut Context<Self>) {
        self.preview.update(cx, |state, cx| {
            let list = state.list_state();
            let max = f32::from(list.max_offset_for_scrollbar().y).max(0.0);
            let y = px_down.clamp(0.0, max);
            list.set_offset_from_scrollbar(point(px(0.), px(-y)));
            cx.notify();
        });
    }

    fn scroll_preview_to_item(&self, item: f32, cx: &mut Context<Self>) {
        self.preview.update(cx, |state, cx| {
            let list = state.list_state();
            if list.item_count() == 0 {
                return;
            }
            let max_ix = list.item_count() - 1;
            let ix = (item.floor() as usize).min(max_ix);
            let frac = (item - ix as f32).clamp(0.0, 1.0);
            let item_h = list
                .bounds_for_item(ix)
                .map(|b| b.size.height)
                .unwrap_or(px(0.));
            let offset = item_h * frac;
            list.scroll_to(ListOffset {
                item_ix: ix,
                offset_in_item: offset,
            });
            let max = f32::from(list.max_offset_for_scrollbar().y).max(0.0);
            let y = (-f32::from(list.scroll_px_offset_for_scrollbar().y)).clamp(0.0, max);
            list.set_offset_from_scrollbar(point(px(0.), px(-y)));
            cx.notify();
        });
    }

    fn preview_style(&self, cx: &App) -> TextViewStyle {
        let mut style = kb_preview_style(cx.theme(), self.preview_zoom);
        if !self.table_wrap {
            let mut table = style.table.clone();
            table.overflow.x = Some(Overflow::Scroll);
            style = style.table(table);
        }
        style
    }

    fn cycle_preview_zoom(&mut self, cx: &mut Context<Self>) {
        self.preview_zoom = if self.preview_zoom >= 1.35 {
            0.9
        } else {
            (self.preview_zoom + 0.1).min(1.35)
        };
        self.preview
            .update(cx, |state, cx| state.invalidate_inline_layout(cx));
        cx.notify();
    }

    fn kb_preview(&self, entity: &WeakEntity<KnowledgePane>, cx: &App) -> TextView {
        let entity = entity.clone();
        let note_dir = self
            .current
            .as_ref()
            .and_then(|p| Path::new(p).parent().map(Path::to_path_buf));
        let lib_root = self.root();
        TextView::new(&self.preview)
            .scrollable(true)
            .selectable(true)
            .style(self.preview_style(cx))
            .text_size(rems(self.preview_zoom))
            .markdown_extensions(kb_markdown_extensions())
            .image_source(move |uri| {
                kb_preview_image_source(uri.as_ref(), note_dir.as_deref(), lib_root.as_deref())
            })
            .px_5()
            .py_4()
            .code_block_actions(|code_block, _window, _cx| {
                h_flex()
                    .gap_1()
                    .child(Clipboard::new("kb-copy-block").value(code_block.code()))
            })
            .on_task_toggle({
                let entity = entity.clone();
                move |event, window, cx| kb_toggle_task(&entity, event, window, cx)
            })
            .on_link_click(move |url, event, window, cx| {
                if event.is_right_click() {
                    return;
                }
                let url = url.as_str();
                if let Some(target) = url.strip_prefix("wiki:///") {
                    if let Some(view) = entity.upgrade() {
                        view.update(cx, |this, cx| {
                            let files = this.files.clone();
                            if let Some(path) = resolve_wikilink(target, &files).map(str::to_string)
                            {
                                this.open_file(&path, window, cx);
                            }
                        });
                    }
                    return;
                }
                cx.open_url(url);
            })
    }

    fn kb_source_editor(&self, cx: &Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .font_family(cx.theme().mono_font_family.clone())
            .text_size(cx.theme().mono_font_size)
            .child(Editor::new(&self.editor).h(relative(1.)).p_0().border_0())
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
        let root_key = self.root().map(|p| p.to_string_lossy().to_string());
        let root_changed = self.loaded_root.as_deref() != root_key.as_deref();
        if root_changed {
            self.expanded.clear();
            self.loaded_root = root_key;
        }
        self.files.clear();
        if let Some(root) = self.root() {
            if let Ok(entries) = list_files_recursive(&root, 2000) {
                self.files = entries.into_iter().map(|e| (e.path, e.relative)).collect();
            }
        }
    }

    fn library_roots(&self) -> Vec<String> {
        self.state.with(|s| s.prefs.knowledge_roots.clone())
    }

    fn switch_root(&mut self, path: String, cx: &mut Context<Self>) {
        let changed = self.state.with_mut(|s| {
            if s.prefs.knowledge_current.as_deref() == Some(path.as_str()) {
                return false;
            }
            s.prefs.knowledge_current = Some(path.clone());
            s.prefs.knowledge_recent.retain(|p| p != &path);
            s.prefs.knowledge_recent.insert(0, path);
            s.prefs.knowledge_recent.truncate(10);
            true
        });
        if !changed {
            return;
        }
        self.current = None;
        self.state.with_mut(|s| s.kb_current_file = None);
        self.state.persist_prefs();
        self.reload_files();
        cx.notify();
    }

    fn add_root(&mut self, cx: &mut Context<Self>) {
        super::prompt_directory(cx, |this, dir, cx| {
            let Some(dir) = dir else {
                return;
            };
            let path = dir.to_string_lossy().to_string();
            this.state.with_mut(|s| {
                if !s.prefs.knowledge_roots.contains(&path) {
                    s.prefs.knowledge_roots.push(path.clone());
                }
                s.prefs.knowledge_current = Some(path.clone());
                s.prefs.knowledge_recent.retain(|p| p != &path);
                s.prefs.knowledge_recent.insert(0, path);
                s.prefs.knowledge_recent.truncate(10);
            });
            this.current = None;
            this.state.with_mut(|s| s.kb_current_file = None);
            this.state.persist_prefs();
            this.reload_files();
            cx.notify();
        });
    }

    fn open_file(&mut self, path: &str, window: &mut Window, cx: &mut Context<Self>) {
        match read_text(std::path::Path::new(path)) {
            Ok(text) => {
                self.current = Some(path.to_string());
                let remember = self.state.with(|s| s.prefs.general.remember_last_note);
                self.state.with_mut(|s| {
                    s.kb_current_file = Some(path.to_string());
                    if remember {
                        s.prefs.general.last_note_path = Some(path.to_string());
                    }
                });
                if remember {
                    self.state.persist_prefs();
                }
                self.editor.update(cx, |input, cx| {
                    input.set_value(text.clone(), window, cx);
                });
                self.preview.update(cx, |state, cx| {
                    state.set_text(&preview_markdown(&text), cx);
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
        let cursor = self.editor.read(cx).selected_range().end;
        match find_spans(&text, &needle, self.find_flags()) {
            Err(err) => self.replace_status = err,
            Ok(spans) if spans.is_empty() => self.replace_status = "未找到".into(),
            Ok(spans) => {
                let ix = spans
                    .iter()
                    .position(|(start, _)| *start >= cursor)
                    .unwrap_or(0);
                let (start, end) = spans[ix];
                self.editor.update(cx, |input, cx| {
                    input.set_selected_range(start..end, cx);
                });
                self.replace_status = format!("第 {}/{} 处", ix + 1, spans.len());
            }
        }
        let _ = window;
        cx.notify();
    }

    fn find_prev(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let needle = self.find.read(cx).value().to_string();
        if needle.is_empty() {
            self.replace_status = "请输入查找内容".into();
            cx.notify();
            return;
        }
        let text = self.editor.read(cx).value().to_string();
        let cursor = self.editor.read(cx).selected_range().start;
        match find_spans(&text, &needle, self.find_flags()) {
            Err(err) => self.replace_status = err,
            Ok(spans) if spans.is_empty() => self.replace_status = "未找到".into(),
            Ok(spans) => {
                let ix = spans
                    .iter()
                    .rposition(|(start, _)| *start < cursor)
                    .unwrap_or(spans.len() - 1);
                let (start, end) = spans[ix];
                self.editor.update(cx, |input, cx| {
                    input.set_selected_range(start..end, cx);
                });
                self.replace_status = format!("第 {}/{} 处", ix + 1, spans.len());
            }
        }
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
        let selected = self.editor.read(cx).selected_range();
        match find_spans(&text, &needle, self.find_flags()) {
            Err(err) => {
                self.replace_status = err;
                cx.notify();
            }
            Ok(spans) => {
                let hit = spans
                    .iter()
                    .copied()
                    .find(|(start, end)| *start == selected.start && *end == selected.end)
                    .or_else(|| {
                        let cursor = selected.end;
                        spans
                            .iter()
                            .copied()
                            .find(|(start, _)| *start >= cursor)
                            .or_else(|| spans.first().copied())
                    });
                let Some((start, end)) = hit else {
                    self.replace_status = "未找到".into();
                    cx.notify();
                    return;
                };
                let mut next = String::with_capacity(text.len());
                next.push_str(&text[..start]);
                next.push_str(&replacement);
                next.push_str(&text[end..]);
                let caret = start + replacement.len();
                self.editor.update(cx, |input, cx| {
                    input.set_value(&next, window, cx);
                    input.set_selected_range(caret..caret, cx);
                });
                self.save_current(&next);
                self.replace_status = "已替换 1 处".into();
                cx.notify();
            }
        }
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
        match find_spans(&text, &needle, self.find_flags()) {
            Err(err) => {
                self.replace_status = err;
                cx.notify();
            }
            Ok(spans) if spans.is_empty() => {
                self.replace_status = "未找到".into();
                cx.notify();
            }
            Ok(spans) => {
                let count = spans.len();
                let mut next = String::with_capacity(text.len());
                let mut last = 0;
                for (start, end) in spans {
                    next.push_str(&text[last..start]);
                    next.push_str(&replacement);
                    last = end;
                }
                next.push_str(&text[last..]);
                self.editor.update(cx, |input, cx| {
                    input.set_value(&next, window, cx);
                });
                self.save_current(&next);
                self.replace_status = format!("已全部替换 {count} 处");
                cx.notify();
            }
        }
    }

    /// Outgoing wikilinks from `body`: (display label, resolved abs path if any).
    fn outgoing_links(&self, body: &str) -> Vec<(String, Option<String>)> {
        let files = &self.files;
        extract_wikilinks(body)
            .into_iter()
            .map(|target| {
                let resolved = resolve_wikilink(&target, files).map(str::to_string);
                (target, resolved)
            })
            .collect()
    }

    /// Files that `[[link]]` to the current note (scan markdown only, cap reads).
    fn backlinks(&self, current_abs: &str) -> Vec<(String, String)> {
        let files = &self.files;
        let mut out = Vec::new();
        for (abs, rel) in files {
            if abs == current_abs {
                continue;
            }
            let is_md = Path::new(abs)
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| {
                    let e = e.to_ascii_lowercase();
                    e == "md" || e == "markdown"
                });
            if !is_md {
                continue;
            }
            if out.len() >= 40 {
                break;
            }
            let Ok(text) = read_text(Path::new(abs)) else {
                continue;
            };
            if body_links_to(&text, current_abs, files) {
                out.push((abs.clone(), rel.clone()));
            }
        }
        out
    }
}

fn kb_surface(
    cx: &Context<KnowledgePane>,
    title: &str,
    body: impl IntoElement,
) -> impl IntoElement {
    let border = cx.theme().border;
    let radius = cx.theme().radius;
    let muted = cx.theme().muted_foreground;
    let secondary = cx.theme().secondary;
    v_flex()
        .size_full()
        .rounded(radius)
        .border_1()
        .border_color(border)
        .overflow_hidden()
        .child(
            h_flex()
                .px_3()
                .py_1p5()
                .gap_2()
                .items_center()
                .bg(secondary)
                .border_b_1()
                .border_color(border)
                .child(
                    div()
                        .text_xs()
                        .font_semibold()
                        .text_color(muted)
                        .child(title.to_string()),
                ),
        )
        .child(div().flex_1().overflow_hidden().child(body))
}

fn doc_stats(text: &str) -> (usize, usize) {
    let lines = text.lines().count().max(1);
    let chars = text.chars().count();
    (lines, chars)
}

/// Colors from `theme_only.css` (Obsidian snippet) that GPUI can actually paint:
/// heading bars, wiki-gold links, coral quotes, GitHub-dark code panels.
struct KbPreviewPalette {
    primary: Hsla,
    internal_link: Hsla,
    bold: Hsla,
    italic: Hsla,
    code_bg: Hsla,
    code_border: Hsla,
    hr: Hsla,
    selection: Hsla,
    table_head: Hsla,
    table_border: Hsla,
    note: Hsla,
    tip: Hsla,
    warning: Hsla,
    important: Hsla,
    caution: Hsla,
}

fn hsl_css(h: f32, s: f32, l: f32) -> Hsla {
    hsla(h / 360., s / 100., l / 100., 1.)
}

fn kb_preview_palette(dark: bool) -> KbPreviewPalette {
    KbPreviewPalette {
        primary: Hsla::from(rgb(0xf9826c)),
        internal_link: hsl_css(37., 100., 50.),
        bold: hsl_css(12., 65., 62.),
        italic: hsl_css(346., 64., 57.),
        code_bg: if dark {
            Hsla::from(rgb(0x161b22))
        } else {
            Hsla::from(rgb(0xf3f4f6))
        },
        code_border: if dark {
            Hsla::from(rgb(0x21262d))
        } else {
            Hsla::from(rgb(0xd0d7de))
        },
        hr: if dark {
            hsl_css(270., 60., 40.)
        } else {
            hsl_css(270., 20., 70.)
        },
        selection: hsla(210. / 360., 0.37, 0.33, 0.45),
        table_head: if dark {
            Hsla::from(rgb(0x21262d))
        } else {
            Hsla::from(rgb(0xeaeef2))
        },
        table_border: if dark {
            Hsla::from(rgb(0x21262d))
        } else {
            Hsla::from(rgb(0xd0d7de))
        },
        note: hsl_css(175., 45., 50.),
        tip: hsl_css(80., 70., 32.),
        warning: hsl_css(37., 100., 50.),
        important: hsl_css(270., 65., 58.8),
        caution: hsl_css(330., 85., 47.2),
    }
}

fn kb_heading_accent(level: u8) -> Hsla {
    match level {
        1 => hsl_css(270., 65., 58.8),
        2 => hsl_css(330., 85., 47.2),
        3 => hsl_css(37., 100., 50.),
        4 => hsl_css(80., 70., 28.5),
        5 => hsl_css(165., 100., 26.),
        _ => hsl_css(175., 45., 50.),
    }
}

fn kb_heading_style(level: u8) -> StyleRefinement {
    let accent = kb_heading_accent(level);
    let weight = if level <= 2 {
        FontWeight::EXTRA_BOLD
    } else {
        FontWeight::BOLD
    };
    StyleRefinement::default()
        .font_weight(weight)
        .text_color(accent)
        .border_l(px(4.))
        .border_color(accent)
        .pl_3()
        .py_1()
        .rounded_l(px(10.))
        .bg(accent.opacity(0.16))
}

fn kb_heading_size(level: u8, base: Pixels) -> Pixels {
    let scale = match level {
        1 => 2.0,
        2 => 1.8,
        3 => 1.6,
        4 => 1.4,
        5 => 1.3,
        _ => 1.2,
    };
    base * scale
}

fn kb_preview_style(theme: &Theme, zoom: f32) -> TextViewStyle {
    let palette = kb_preview_palette(theme.is_dark());
    let mut code = StyleRefinement::default()
        .p_3()
        .rounded(px(8.))
        .border_1()
        .border_color(palette.code_border)
        .bg(palette.code_bg)
        .font_family(theme.mono_font_family.clone())
        .max_h(px(360.));
    code.overflow.y = Some(Overflow::Scroll);
    let mut style = TextViewStyle::default()
        .paragraph_gap(rems(0.85))
        .heading_font_size(kb_heading_size)
        .heading(kb_heading_style)
        .link(palette.internal_link)
        .list(
            StyleRefinement::default()
                .text_color(palette.internal_link)
                .font_weight(FontWeight::BOLD),
        )
        .blockquote(
            StyleRefinement::default()
                .border_l(px(3.))
                .border_color(palette.primary)
                .pl_3()
                .py_1()
                .rounded_r(px(6.))
                .bg(palette.primary.opacity(0.08))
                .text_color(palette.italic),
        )
        .code_block(code)
        .code_background(palette.code_bg)
        .inline_code(HighlightStyle {
            color: Some(palette.bold),
            background_color: Some(palette.code_bg),
            font_weight: Some(FontWeight::MEDIUM),
            ..Default::default()
        })
        .inline_code_box(
            StyleRefinement::default()
                .px_1()
                .py(px(1.))
                .rounded(px(4.))
                .border_1()
                .border_color(palette.code_border)
                .bg(palette.code_bg)
                .text_color(palette.bold)
                .font_family(theme.mono_font_family.clone()),
        )
        .table(
            StyleRefinement::default()
                .rounded(px(8.))
                .border_1()
                .border_color(palette.table_border),
        )
        .table_head(
            StyleRefinement::default()
                .bg(palette.table_head)
                .text_color(palette.internal_link)
                .font_weight(FontWeight::SEMIBOLD)
                .px_3()
                .py_2(),
        )
        .table_cell(StyleRefinement::default().px_3().py_2())
        .table_row_hover(palette.internal_link.opacity(0.12))
        .border(palette.hr)
        .selection(palette.selection);
    style.heading_base_font_size = theme.font_size * zoom;
    style.highlight_theme = theme.highlight_theme.clone();
    style.is_dark = theme.is_dark();
    style
}

fn kb_callout(
    label: &'static str,
    icon: IconName,
    color: Hsla,
) -> impl Fn(&mut Window, &mut App) -> Div + Send + Sync + 'static {
    move |_, _| {
        v_flex()
            .p_3()
            .gap_2()
            .rounded(px(8.))
            .border_1()
            .border_color(color.opacity(0.45))
            .bg(color.opacity(0.1))
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .text_color(color)
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(Icon::new(icon.clone()).text_color(color))
                    .child(label),
            )
    }
}

fn kb_markdown_extensions() -> MarkdownExtensions {
    static EXTENSIONS: std::sync::OnceLock<MarkdownExtensions> = std::sync::OnceLock::new();
    EXTENSIONS
        .get_or_init(|| {
            let palette = kb_preview_palette(true);
            MarkdownExtensions::default()
                .frontmatter()
                .plugin(FrontmatterPlugin::new())
                .block_surface("note", kb_callout("Note", IconName::Info, palette.note))
                .block_surface("info", kb_callout("Info", IconName::Info, palette.note))
                .block_surface(
                    "abstract",
                    kb_callout("Abstract", IconName::Info, palette.note),
                )
                .block_surface(
                    "summary",
                    kb_callout("Summary", IconName::Info, palette.note),
                )
                .block_surface("tldr", kb_callout("TL;DR", IconName::Info, palette.note))
                .block_surface("faq", kb_callout("FAQ", IconName::Info, palette.note))
                .block_surface("tip", kb_callout("Tip", IconName::CircleCheck, palette.tip))
                .block_surface(
                    "hint",
                    kb_callout("Hint", IconName::CircleCheck, palette.tip),
                )
                .block_surface(
                    "todo",
                    kb_callout("Todo", IconName::CircleCheck, palette.tip),
                )
                .block_surface(
                    "success",
                    kb_callout("Success", IconName::CircleCheck, palette.tip),
                )
                .block_surface(
                    "warning",
                    kb_callout("Warning", IconName::TriangleAlert, palette.warning),
                )
                .block_surface(
                    "important",
                    kb_callout("Important", IconName::Star, palette.important),
                )
                .block_surface(
                    "example",
                    kb_callout("Example", IconName::Star, palette.important),
                )
                .block_surface(
                    "caution",
                    kb_callout("Caution", IconName::CircleX, palette.caution),
                )
                .block_surface(
                    "danger",
                    kb_callout("Danger", IconName::CircleX, palette.caution),
                )
                .block_surface("bug", kb_callout("Bug", IconName::CircleX, palette.caution))
                .block_surface(
                    "error",
                    kb_callout("Error", IconName::CircleX, palette.caution),
                )
                .block_surface(
                    "failure",
                    kb_callout("Failure", IconName::CircleX, palette.caution),
                )
                .block_surface("quote", kb_callout("Quote", IconName::Info, palette.italic))
        })
        .clone()
}

/// Turn `[[note]]` / `[[note|别名]]` into Markdown links for the preview pane.
fn wikilinks_for_preview(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if i + 3 < bytes.len() && bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(rel) = body[i + 2..].find("]]") {
                let inner = &body[i + 2..i + 2 + rel];
                let target = inner.split('|').next().unwrap_or(inner).trim();
                let label = inner.split('|').nth(1).unwrap_or(target).trim();
                if !target.is_empty() {
                    let is_image = Path::new(target)
                        .extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(is_image_extension);
                    if is_image && i > 0 && bytes[i - 1] == b'!' {
                        out.pop();
                        out.push_str("![");
                        out.push_str(label);
                        out.push_str("](");
                        out.push_str(target);
                        out.push(')');
                    } else {
                        out.push('[');
                        out.push_str(label);
                        out.push_str("](wiki:///");
                        out.push_str(target);
                        out.push(')');
                    }
                    i = i + 2 + rel + 2;
                    continue;
                }
            }
        }
        let ch = body[i..].chars().next().unwrap();
        let len = ch.len_utf8();
        out.push(ch);
        i += len;
    }
    out
}

fn preview_markdown(body: &str) -> String {
    highlights_for_preview(&wikilinks_for_preview(body))
}

/// Obsidian `==highlight==` is not CommonMark; render it as `<mark>`.
fn highlights_for_preview(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let bytes = body.as_bytes();
    let mut i = 0usize;
    let mut in_fence = false;
    while i < bytes.len() {
        if (i == 0 || bytes[i - 1] == b'\n') && body[i..].starts_with("```") {
            in_fence = !in_fence;
            out.push_str("```");
            i += 3;
            continue;
        }
        if in_fence {
            let ch = body[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        if bytes[i] == b'`' {
            out.push('`');
            i += 1;
            while i < bytes.len() && bytes[i] != b'`' && bytes[i] != b'\n' {
                let ch = body[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8();
            }
            if i < bytes.len() && bytes[i] == b'`' {
                out.push('`');
                i += 1;
            }
            continue;
        }
        if body[i..].starts_with("==")
            && let Some(rel) = body[i + 2..].find("==")
        {
            let inner = &body[i + 2..i + 2 + rel];
            if !inner.is_empty() && !inner.contains('\n') {
                out.push_str("<mark color=\"#ffa000\">");
                out.push_str(&escape_html(inner));
                out.push_str("</mark>");
                i += 4 + rel;
                continue;
            }
        }
        let ch = body[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

fn task_checkbox_ranges(text: &str) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let content = line.trim_end_matches(['\n', '\r']);
        let indent = content.len() - content.trim_start().len();
        let trimmed = &content[indent..];
        let rest = trimmed.as_bytes();
        let mut j = 0usize;
        let listed = if !rest.is_empty() && matches!(rest[0], b'*' | b'-' | b'+') {
            j = 1;
            true
        } else if rest.first().is_some_and(u8::is_ascii_digit) {
            while j < rest.len() && rest[j].is_ascii_digit() {
                j += 1;
            }
            if j < rest.len() && matches!(rest[j], b'.' | b')') {
                j += 1;
                true
            } else {
                false
            }
        } else {
            false
        };
        if listed {
            while j < rest.len() && (rest[j] == b' ' || rest[j] == b'\t') {
                j += 1;
            }
            if j + 2 < rest.len()
                && rest[j] == b'['
                && matches!(rest[j + 1], b' ' | b'x' | b'X')
                && rest[j + 2] == b']'
            {
                let start = offset + indent + j;
                ranges.push(start..start + 3);
            }
        }
        offset += line.len();
    }
    ranges
}

fn apply_preview_task_toggle(
    source: &str,
    preview: &str,
    marker: std::ops::Range<usize>,
    checked: bool,
) -> Option<String> {
    let replacement = if checked { "[x]" } else { "[ ]" };
    let preview_ranges = task_checkbox_ranges(preview);
    let index = preview_ranges.iter().position(|range| range == &marker)?;
    let source_range = task_checkbox_ranges(source).into_iter().nth(index)?;
    let old = source.get(source_range.clone())?;
    if old != "[ ]" && !old.eq_ignore_ascii_case("[x]") {
        return None;
    }
    let mut next = String::with_capacity(source.len());
    next.push_str(&source[..source_range.start]);
    next.push_str(replacement);
    next.push_str(&source[source_range.end..]);
    Some(next)
}

fn kb_toggle_task(
    entity: &WeakEntity<KnowledgePane>,
    event: &TaskToggleEvent,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(view) = entity.upgrade() else {
        return;
    };
    view.update(cx, |this, cx| {
        let source = this.editor.read(cx).value().to_string();
        let preview = preview_markdown(&source);
        let Some(next) =
            apply_preview_task_toggle(&source, &preview, event.marker_range(), event.checked())
        else {
            return;
        };
        this.editor.update(cx, |input, cx| {
            input.set_value(&next, window, cx);
        });
        this.save_current(&next);
        this.sync_preview(cx);
        cx.notify();
    });
}

fn kb_preview_image_source(
    uri: &str,
    note_dir: Option<&Path>,
    lib_root: Option<&Path>,
) -> gpui::ImageSource {
    let uri = uri.trim();
    if uri.starts_with("data:")
        || uri.starts_with("http://")
        || uri.starts_with("https://")
        || uri.starts_with("wiki:///")
    {
        return gpui::SharedUri::from(uri.to_string()).into();
    }
    if let Some(path) = file_uri_to_path(uri) {
        return gpui::ImageSource::from(path);
    }
    if let Some(path) = resolve_preview_image_path(uri, note_dir, lib_root) {
        return gpui::ImageSource::from(path);
    }
    gpui::SharedUri::from(uri.to_string()).into()
}

fn resolve_preview_image_path(
    uri: &str,
    note_dir: Option<&Path>,
    lib_root: Option<&Path>,
) -> Option<PathBuf> {
    let decoded = percent_decode_path(uri);
    if decoded.is_empty() {
        return None;
    }
    let raw = PathBuf::from(&decoded);
    if raw.is_absolute() {
        return Some(raw);
    }
    let rel = decoded.trim_start_matches("./");
    let from_note = note_dir.map(|dir| dir.join(rel));
    if from_note.as_ref().is_some_and(|p| p.is_file()) {
        return from_note;
    }
    let from_root = lib_root.map(|root| root.join(rel));
    if from_root.as_ref().is_some_and(|p| p.is_file()) {
        return from_root;
    }
    from_note.or(from_root)
}

fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file:")?;
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let rest = rest
        .strip_prefix("localhost")
        .or_else(|| rest.strip_prefix("LOCALHOST"))
        .unwrap_or(rest);
    let decoded = percent_decode_path(rest);
    if decoded.is_empty() {
        return None;
    }
    #[cfg(windows)]
    {
        let trimmed = decoded.trim_start_matches('/');
        if trimmed.chars().nth(1) == Some(':') {
            return Some(PathBuf::from(trimmed));
        }
    }
    Some(PathBuf::from(decoded))
}

fn percent_decode_path(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(value) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
        {
            out.push(value);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn build_kb_tree(entries: &[(String, String, Option<String>)]) -> Vec<KbTreeNode> {
    let mut roots = Vec::new();
    for (path, relative, snippet) in entries {
        let parts: Vec<&str> = relative
            .split(['/', '\\'])
            .filter(|part| !part.is_empty())
            .collect();
        if parts.is_empty() {
            continue;
        }
        insert_kb_node(&mut roots, &parts, path, "", snippet.clone());
    }
    sort_kb_tree(&mut roots);
    roots
}

fn insert_kb_node(
    nodes: &mut Vec<KbTreeNode>,
    parts: &[&str],
    path: &str,
    parent_key: &str,
    snippet: Option<String>,
) {
    let name = parts[0];
    let key = if parent_key.is_empty() {
        name.to_string()
    } else {
        format!("{parent_key}/{name}")
    };
    if parts.len() == 1 {
        if let Some(existing) = nodes
            .iter_mut()
            .find(|node| node.file_path.is_some() && node.name == name)
        {
            if snippet.is_some() {
                existing.snippet = snippet;
            }
            return;
        }
        nodes.push(KbTreeNode {
            name: name.to_string(),
            key,
            file_path: Some(path.to_string()),
            snippet,
            children: Vec::new(),
        });
        return;
    }
    if let Some(index) = nodes
        .iter()
        .position(|node| node.file_path.is_none() && node.name == name)
    {
        let dir_key = nodes[index].key.clone();
        insert_kb_node(
            &mut nodes[index].children,
            &parts[1..],
            path,
            &dir_key,
            snippet,
        );
        return;
    }
    let mut dir = KbTreeNode {
        name: name.to_string(),
        key: key.clone(),
        file_path: None,
        snippet: None,
        children: Vec::new(),
    };
    insert_kb_node(&mut dir.children, &parts[1..], path, &key, snippet);
    nodes.push(dir);
}

fn sort_kb_tree(nodes: &mut [KbTreeNode]) {
    nodes.sort_by(|a, b| {
        a.file_path
            .is_some()
            .cmp(&b.file_path.is_some())
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    for node in nodes.iter_mut() {
        sort_kb_tree(&mut node.children);
    }
}

fn kb_tree_rows(
    nodes: &[KbTreeNode],
    depth: usize,
    force_open: bool,
    expanded: &HashSet<String>,
    current: Option<&str>,
    entity: &WeakEntity<KnowledgePane>,
    cx: &mut Context<KnowledgePane>,
) -> Vec<AnyElement> {
    let mut rows = Vec::new();
    let accent = cx.theme().accent;
    let muted = cx.theme().muted_foreground;
    let radius = cx.theme().radius;
    for node in nodes {
        let is_dir = node.file_path.is_none();
        let open = is_dir && (force_open || expanded.contains(&node.key));
        let active = node.file_path.as_deref() == current;
        let label = if is_dir {
            format!("{} {}", if open { "▾" } else { "▸" }, node.name)
        } else {
            node.name.clone()
        };
        let key = node.key.clone();
        let file_path = node.file_path.clone();
        let row_entity = entity.clone();
        let row = v_flex()
            .id(SharedString::from(format!("kb-tree-{key}")))
            .gap_0p5()
            .py_1()
            .pr_2()
            .pl(px(8. + depth as f32 * 14.))
            .rounded(radius)
            .text_xs()
            .overflow_x_hidden()
            .when(active, |row| row.bg(accent))
            .hover(|row| row.bg(accent))
            .cursor_pointer()
            .child(
                div()
                    .w_full()
                    .overflow_x_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .when(is_dir, |name| name.text_color(muted))
                    .child(label),
            )
            .when_some(node.snippet.clone(), |col, snippet| {
                col.child(
                    div()
                        .w_full()
                        .overflow_x_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_xs()
                        .text_color(muted)
                        .child(snippet),
                )
            })
            .on_click(move |_, window, app| {
                let Some(view) = row_entity.upgrade() else {
                    return;
                };
                if let Some(path) = file_path.clone() {
                    view.update(app, |this, cx| this.open_file(&path, window, cx));
                } else {
                    let key = key.clone();
                    view.update(app, |this, cx| {
                        if !this.expanded.remove(&key) {
                            this.expanded.insert(key);
                        }
                        cx.notify();
                    });
                }
            });
        rows.push(row.into_any_element());
        if open {
            rows.extend(kb_tree_rows(
                &node.children,
                depth + 1,
                force_open,
                expanded,
                current,
                entity,
                cx,
            ));
        }
    }
    rows
}

impl Render for KnowledgePane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let pending = self.state.with(|s| s.kb_current_file.clone());
        if let Some(path) = pending {
            if self.current.as_deref() != Some(path.as_str()) {
                self.open_file(&path, window, cx);
            }
        }
        let filter_raw = self.filter.read(cx).value().to_string();
        let filter = filter_raw.trim().to_lowercase();
        let filtering = !filter.is_empty();
        // (path, relative, optional body snippet)
        let entries: Vec<(String, String, Option<String>)> = if !filtering {
            self.files
                .iter()
                .map(|(p, r)| (p.clone(), r.clone(), None))
                .collect()
        } else if filter.chars().count() >= 2 {
            if let Some(root) = self.root() {
                match search_kb_content(&root, &filter_raw, 800, 80) {
                    Ok(hits) if !hits.is_empty() => hits
                        .into_iter()
                        .map(|h| {
                            let snip = if h.line > 0 {
                                Some(format!("L{} · {}", h.line, h.snippet))
                            } else {
                                None
                            };
                            (h.path, h.relative, snip)
                        })
                        .collect(),
                    _ => self
                        .files
                        .iter()
                        .filter(|(_, rel)| rel.to_lowercase().contains(&filter))
                        .map(|(p, r)| (p.clone(), r.clone(), None))
                        .collect(),
                }
            } else {
                Vec::new()
            }
        } else {
            self.files
                .iter()
                .filter(|(_, rel)| rel.to_lowercase().contains(&filter))
                .map(|(p, r)| (p.clone(), r.clone(), None))
                .collect()
        };
        let tree = build_kb_tree(&entries);
        let entity = cx.weak_entity();
        let current = self.current.clone();
        let tree_rows = kb_tree_rows(
            &tree,
            0,
            filtering,
            &self.expanded,
            current.as_deref(),
            &entity,
            cx,
        );
        let library_label = self.library_label();
        let library_roots = self.library_roots();
        let current_root = self.root().map(|p| p.to_string_lossy().into_owned());
        let preview_text = self.editor.read(cx).value().to_string();
        let (line_count, char_count) = doc_stats(&preview_text);
        let mode = self.mode;
        let replace_status = self.replace_status.clone();
        let preview_zoom = self.preview_zoom;
        let table_wrap = self.table_wrap;
        let find_open = self.find_open;
        let find_word = self.find_word;
        let find_case = self.find_case;
        let find_regex = self.find_regex;
        let note_title = self
            .current_file_name()
            .unwrap_or_else(|| "未打开笔记".into());
        let muted = cx.theme().muted_foreground;
        let border = cx.theme().border;
        let accent = cx.theme().accent;
        let popover = cx.theme().popover;
        let popover_fg = cx.theme().popover_foreground;

        div()
            .size_full()
            .on_action(cx.listener(|this, _: &FindNote, window, cx| this.open_find(window, cx)))
            .on_action(cx.listener(|this, _: &CloseFind, _, cx| this.close_find(cx)))
            .child(
        h_flex()
            .size_full()
            .child(
                v_flex()
                    .w(px(280.))
                    .h_full()
                    .border_r_1()
                    .border_color(border)
                    .bg(cx.theme().sidebar)
                    .p_3()
                    .gap_2()
                    .child({
                        let lib = Button::new("kb-lib")
                            .small()
                            .outline()
                            .w_full()
                            .icon(IconName::Folder)
                            .label(library_label);
                        if library_roots.is_empty() {
                            lib.on_click(cx.listener(|this, _, _, cx| this.add_root(cx)))
                                .into_any_element()
                        } else {
                            let pane = entity.clone();
                            let roots = library_roots.clone();
                            let active = current_root.clone();
                            lib.dropdown_menu(move |menu, _, _| {
                                let mut menu = menu;
                                for root in roots.iter() {
                                    let pane = pane.clone();
                                    let path = root.clone();
                                    let name = Path::new(root)
                                        .file_name()
                                        .map(|n| n.to_string_lossy().into_owned())
                                        .filter(|n| !n.is_empty())
                                        .unwrap_or_else(|| root.clone());
                                    menu = menu.item(
                                        PopupMenuItem::new(name)
                                            .checked(active.as_deref() == Some(path.as_str()))
                                            .on_click(move |_, _, app| {
                                                if let Some(view) = pane.upgrade() {
                                                    let path = path.clone();
                                                    view.update(app, |this, cx| {
                                                        this.switch_root(path, cx);
                                                    });
                                                }
                                            }),
                                    );
                                }
                                let pane_add = pane.clone();
                                menu.separator().item(
                                    PopupMenuItem::new("添加库…").on_click(move |_, _, app| {
                                        if let Some(view) = pane_add.upgrade() {
                                            view.update(app, |this, cx| this.add_root(cx));
                                        }
                                    }),
                                )
                            })
                            .into_any_element()
                        }
                    })
                    .child(Input::new(&self.filter).cleanable(true))
                    .child({
                        let mut list = v_flex().gap_0p5().flex_1().overflow_y_scrollbar();
                        if tree_rows.is_empty() {
                            list =
                                list.child(div().text_xs().text_color(muted).child(if filtering {
                                    "没有匹配的文件"
                                } else {
                                    "库中没有可打开的文件"
                                }));
                        } else {
                            list = list.children(tree_rows);
                        }
                        list
                    }),
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
                                Icon::new(IconName::BookOpen)
                                    .size(px(16.))
                                    .text_color(accent),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .text_sm()
                                    .font_semibold()
                                    .overflow_x_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .child(note_title),
                            )
                            .child(
                                Button::new("kb-find-toggle")
                                    .small()
                                    .ghost()
                                    .icon(IconName::Search)
                                    .tooltip("查找 (Ctrl+F)")
                                    .selected(find_open)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        if this.find_open {
                                            this.close_find(cx);
                                        } else {
                                            this.open_find(window, cx);
                                        }
                                    })),
                            )
                            .child({
                                let pane = entity.clone();
                                let path = current.clone();
                                Button::new("kb-more")
                                    .small()
                                    .ghost()
                                    .icon(IconName::Ellipsis)
                                    .tooltip("更多")
                                    .dropdown_menu_with_anchor(Anchor::BottomRight, move |menu, _, _| {
                                        let pane_live = pane.clone();
                                        let pane_source = pane.clone();
                                        let pane_preview = pane.clone();
                                        let pane_new = pane.clone();
                                        let reveal_path = path.clone();
                                        let can_create = current_root.is_some();
                                        menu.item(
                                            PopupMenuItem::new("实时模式")
                                                .checked(mode == KbMode::Live)
                                                .on_click(move |_, _, app| {
                                                    if let Some(view) = pane_live.upgrade() {
                                                        view.update(app, |this, cx| {
                                                            this.mode = KbMode::Live;
                                                            cx.notify();
                                                        });
                                                    }
                                                }),
                                        )
                                        .item(
                                            PopupMenuItem::new("源码模式")
                                                .checked(mode == KbMode::Source)
                                                .on_click(move |_, _, app| {
                                                    if let Some(view) = pane_source.upgrade() {
                                                        view.update(app, |this, cx| {
                                                            this.mode = KbMode::Source;
                                                            cx.notify();
                                                        });
                                                    }
                                                }),
                                        )
                                        .item(
                                            PopupMenuItem::new("预览模式")
                                                .checked(mode == KbMode::Preview)
                                                .on_click(move |_, _, app| {
                                                    if let Some(view) = pane_preview.upgrade() {
                                                        view.update(app, |this, cx| {
                                                            let text = this.editor.read(cx).value().to_string();
                                                            this.save_current(&text);
                                                            this.mode = KbMode::Preview;
                                                            cx.notify();
                                                        });
                                                    }
                                                }),
                                        )
                                        .separator()
                                        .item(
                                            PopupMenuItem::new("新建笔记")
                                                .disabled(!can_create)
                                                .on_click(move |_, window, app| {
                                                    if let Some(view) = pane_new.upgrade() {
                                                        view.update(app, |this, cx| {
                                                            this.new_md(window, cx)
                                                        });
                                                    }
                                                }),
                                        )
                                        .item(
                                            PopupMenuItem::new("在资源管理器中显示")
                                                .disabled(reveal_path.is_none())
                                                .on_click(move |_, _, cx| {
                                                    if let Some(path) = reveal_path.as_ref() {
                                                        cx.reveal_path(Path::new(path));
                                                    }
                                                }),
                                        )
                                    })
                            }),
                    )
                    .when(current.is_none(), |col| {
                        col.child(
                            div()
                                .flex_1()
                                .items_center()
                                .justify_center()
                                .child(
                                    v_flex()
                                        .gap_3()
                                        .items_center()
                                        .max_w(px(320.))
                                        .child(
                                            Icon::new(IconName::BookOpen)
                                                .size(px(40.))
                                                .text_color(muted),
                                        )
                                        .child(
                                            div()
                                                .text_base()
                                                .font_semibold()
                                                .child("选择或新建一篇笔记"),
                                        )
                                        .child(
                                            div()
                                                .text_sm()
                                                .text_color(muted)
                                                .text_center()
                                                .child(
                                                    "左侧可折叠目录并检索正文；Ctrl+F 查找替换；[[笔记名]] 会出现在底栏。",
                                                ),
                                        )
                                        .child(
                                            Button::new("kb-empty-new")
                                                .primary()
                                                .icon(IconName::Plus)
                                                .label("新建 Markdown")
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.new_md(window, cx);
                                                })),
                                        ),
                                ),
                        )
                    })
                    .when(current.is_some(), |col| {
                        col.child({
                            let entity = entity.clone();
                            let editor = match mode {
                                KbMode::Live => {
                                    self.sync_preview(cx);
                                    h_resizable("kb-live")
                                        .child(resizable_panel().child(kb_surface(
                                            cx,
                                            "Markdown 源码",
                                            self.kb_source_editor(cx),
                                        )))
                                        .child(resizable_panel().child(kb_surface(
                                            cx,
                                            "渲染预览",
                                            self.kb_preview(&entity, cx),
                                        )))
                                        .into_any_element()
                                }
                                KbMode::Source => div()
                                    .size_full()
                                    .child(kb_surface(
                                        cx,
                                        "Markdown 源码",
                                        self.kb_source_editor(cx),
                                    ))
                                    .into_any_element(),
                                KbMode::Preview => {
                                    self.sync_preview(cx);
                                    div()
                                        .size_full()
                                        .child(kb_surface(
                                            cx,
                                            "渲染预览",
                                            self.kb_preview(&entity, cx),
                                        ))
                                        .into_any_element()
                                }
                            };
                            div()
                                .flex_1()
                                .relative()
                                .overflow_hidden()
                                .child(editor)
                                .when(find_open, |wrap| {
                                    wrap.child(
                                        v_flex()
                                            .absolute()
                                            .top_2()
                                            .right_2()
                                            .w(px(420.))
                                            .p_2()
                                            .gap_1p5()
                                            .rounded(cx.theme().radius)
                                            .border_1()
                                            .border_color(border)
                                            .bg(popover)
                                            .text_color(popover_fg)
                                            .shadow_md()
                                            .child(
                                                h_flex()
                                                    .gap_1()
                                                    .items_center()
                                                    .child(Input::new(&self.find).cleanable(true).flex_1())
                                                    .child({
                                                        let pane = entity.clone();
                                                        Toggle::new("kb-find-word")
                                                            .ghost()
                                                            .xsmall()
                                                            .label("W")
                                                            .tooltip("全词匹配")
                                                            .checked(find_word)
                                                            .on_click(move |checked, _, app| {
                                                                if let Some(view) = pane.upgrade() {
                                                                    view.update(app, |this, cx| {
                                                                        this.find_word = *checked;
                                                                        this.sync_editor_search(cx);
                                                                    });
                                                                }
                                                            })
                                                    })
                                                    .child({
                                                        let pane = entity.clone();
                                                        Toggle::new("kb-find-case")
                                                            .ghost()
                                                            .xsmall()
                                                            .label("Aa")
                                                            .tooltip("区分大小写")
                                                            .checked(find_case)
                                                            .on_click(move |checked, _, app| {
                                                                if let Some(view) = pane.upgrade() {
                                                                    view.update(app, |this, cx| {
                                                                        this.find_case = *checked;
                                                                        this.sync_editor_search(cx);
                                                                    });
                                                                }
                                                            })
                                                    })
                                                    .child({
                                                        let pane = entity.clone();
                                                        Toggle::new("kb-find-regex")
                                                            .ghost()
                                                            .xsmall()
                                                            .label("*")
                                                            .tooltip("正则表达式")
                                                            .checked(find_regex)
                                                            .on_click(move |checked, _, app| {
                                                                if let Some(view) = pane.upgrade() {
                                                                    view.update(app, |this, cx| {
                                                                        this.find_regex = *checked;
                                                                        this.sync_editor_search(cx);
                                                                    });
                                                                }
                                                            })
                                                    }),
                                            )
                                            .child(
                                                h_flex()
                                                    .gap_1()
                                                    .items_center()
                                                    .child(Input::new(&self.replace).cleanable(true).flex_1())
                                                    .child(
                                                        Button::new("kb-find-prev")
                                                            .xsmall()
                                                            .outline()
                                                            .label("上一处")
                                                            .on_click(cx.listener(|this, _, window, cx| {
                                                                this.find_prev(window, cx);
                                                            })),
                                                    )
                                                    .child(
                                                        Button::new("kb-find-go")
                                                            .xsmall()
                                                            .outline()
                                                            .label("查找")
                                                            .tooltip("下一处；Enter 下一处，Shift+Enter 上一处")
                                                            .on_click(cx.listener(|this, _, window, cx| {
                                                                this.find_next(window, cx);
                                                            })),
                                                    )
                                                    .child(
                                                        Button::new("kb-repl")
                                                            .xsmall()
                                                            .outline()
                                                            .label("替换")
                                                            .on_click(cx.listener(|this, _, window, cx| {
                                                                this.replace_once(window, cx);
                                                            })),
                                                    )
                                                    .child(
                                                        Button::new("kb-repl-all")
                                                            .xsmall()
                                                            .primary()
                                                            .label("全部替换")
                                                            .on_click(cx.listener(|this, _, window, cx| {
                                                                this.replace_all(window, cx);
                                                            })),
                                                    ),
                                            )
                                            .when(!replace_status.is_empty(), |box_| {
                                                box_.child(
                                                    div()
                                                        .text_xs()
                                                        .text_color(muted)
                                                        .child(replace_status.clone()),
                                                )
                                            }),
                                    )
                                })
                                .into_any_element()
                        })
                        .child({
                            let cur = current.clone().unwrap();
                            let outgoing = self.outgoing_links(&preview_text);
                            let backs = self.backlinks(&cur);
                            let out_n = outgoing.len();
                            let back_n = backs.len();
                            let entity = entity.clone();
                            StatusBar::new()
                                .left(
                                    h_flex()
                                        .gap_2()
                                        .items_center()
                                        .overflow_x_hidden()
                                        .child(
                                            div().text_xs().text_color(muted).child(format!(
                                                "{line_count} 行 · {char_count} 字 · 出链 {out_n} · 反向 {back_n}"
                                            )),
                                        )
                                        .children(outgoing.into_iter().enumerate().map(|(i, (label, path))| {
                                            let entity = entity.clone();
                                            let resolved = path.clone();
                                            Button::new(SharedString::from(format!("wiki-out-{i}")))
                                                .xsmall()
                                                .ghost()
                                                .label(if path.is_some() {
                                                    format!("→ [[{label}]]")
                                                } else {
                                                    format!("→ [[{label}]] ?")
                                                })
                                                .disabled(path.is_none())
                                                .on_click(move |_, window, app| {
                                                    if let (Some(p), Some(e)) = (resolved.as_ref(), entity.upgrade()) {
                                                        let p = p.clone();
                                                        e.update(app, |this, cx| this.open_file(&p, window, cx));
                                                    }
                                                })
                                        }))
                                        .children(backs.into_iter().enumerate().map(|(i, (path, rel))| {
                                            let entity = entity.clone();
                                            Button::new(SharedString::from(format!("wiki-back-{i}")))
                                                .xsmall()
                                                .ghost()
                                                .label(format!("← {rel}"))
                                                .on_click(move |_, window, app| {
                                                    if let Some(e) = entity.upgrade() {
                                                        let p = path.clone();
                                                        e.update(app, |this, cx| this.open_file(&p, window, cx));
                                                    }
                                                })
                                        })),
                                )
                                .when(matches!(mode, KbMode::Live | KbMode::Preview), |bar| {
                                    bar.right(
                                        Button::new("kb-zoom")
                                            .ghost()
                                            .xsmall()
                                            .label(format!("预览 {:.0}%", preview_zoom * 100.))
                                            .on_click(cx.listener(|this, _, _, cx| this.cycle_preview_zoom(cx))),
                                    )
                                    .right(
                                        Button::new("kb-table")
                                            .ghost()
                                            .xsmall()
                                            .label(if table_wrap { "表格：换行" } else { "表格：横滚" })
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.table_wrap = !this.table_wrap;
                                                cx.notify();
                                            })),
                                    )
                                })
                        })
                    }),
            ))
    }
}

#[derive(Debug, Clone)]
struct ScrollOutline {
    /// Pairs of (source line, preview list item), including document start/end.
    anchors: Vec<(f32, f32)>,
}

impl ScrollOutline {
    fn item_for_line(&self, line: f32) -> f32 {
        map_axis(line, &self.anchors)
    }

    fn line_for_item(&self, item: f32) -> f32 {
        let swapped: Vec<(f32, f32)> = self.anchors.iter().map(|(l, i)| (*i, *l)).collect();
        map_axis(item, &swapped)
    }
}

fn map_axis(pos: f32, anchors: &[(f32, f32)]) -> f32 {
    if anchors.is_empty() {
        return 0.0;
    }
    if anchors.len() == 1 || pos <= anchors[0].0 {
        return anchors[0].1;
    }
    for pair in anchors.windows(2) {
        let (x0, y0) = pair[0];
        let (x1, y1) = pair[1];
        if pos <= x1 {
            if (x1 - x0).abs() < f32::EPSILON {
                return y0;
            }
            let t = ((pos - x0) / (x1 - x0)).clamp(0.0, 1.0);
            return y0 + t * (y1 - y0);
        }
    }
    anchors[anchors.len() - 1].1
}

fn is_atx_heading(line: &str) -> bool {
    let t = line.trim();
    let hashes = t.bytes().take_while(|&b| b == b'#').count();
    (1..=6).contains(&hashes) && (t.len() == hashes || t.as_bytes().get(hashes) == Some(&b' '))
}

fn is_fence(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

fn is_list_item(line: &str) -> bool {
    let t = line.trim_start();
    if t.starts_with("- ") || t.starts_with("* ") || t.starts_with("+ ") {
        return true;
    }
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && t.as_bytes().get(digits..digits + 2) == Some(b". ")
}

fn is_hr(line: &str) -> bool {
    let t: String = line.trim().chars().filter(|c| !c.is_whitespace()).collect();
    t.len() >= 3
        && (t.bytes().all(|b| b == b'-')
            || t.bytes().all(|b| b == b'*')
            || t.bytes().all(|b| b == b'_'))
}

/// Approximate gpui-kit markdown list rows: each ATX heading, fence, rule,
/// list, blockquote or paragraph is one top-level block.
fn markdown_scroll_outline(source: &str) -> ScrollOutline {
    let lines: Vec<&str> = source.split('\n').collect();
    let last_line = lines.len().saturating_sub(1);
    let mut headings: Vec<(usize, usize)> = Vec::new();
    let mut next_item = 0usize;
    let mut in_fence = false;
    let mut para_open = false;
    let mut list_open = false;
    let mut quote_open = false;

    let close_flow = |para: &mut bool, list: &mut bool, quote: &mut bool| {
        *para = false;
        *list = false;
        *quote = false;
    };

    for (line_idx, line) in lines.iter().enumerate() {
        if is_fence(line) {
            if !in_fence {
                close_flow(&mut para_open, &mut list_open, &mut quote_open);
                next_item += 1;
                in_fence = true;
            } else {
                in_fence = false;
            }
            continue;
        }
        if in_fence {
            continue;
        }
        if line.trim().is_empty() {
            close_flow(&mut para_open, &mut list_open, &mut quote_open);
            continue;
        }
        if is_atx_heading(line) {
            close_flow(&mut para_open, &mut list_open, &mut quote_open);
            headings.push((line_idx, next_item));
            next_item += 1;
            continue;
        }
        if is_hr(line) {
            close_flow(&mut para_open, &mut list_open, &mut quote_open);
            next_item += 1;
            continue;
        }
        if line.trim_start().starts_with('>') {
            if !quote_open {
                close_flow(&mut para_open, &mut list_open, &mut quote_open);
                quote_open = true;
                next_item += 1;
            }
            continue;
        }
        if is_list_item(line) {
            if !list_open {
                close_flow(&mut para_open, &mut list_open, &mut quote_open);
                list_open = true;
                next_item += 1;
            }
            continue;
        }
        if !para_open {
            close_flow(&mut para_open, &mut list_open, &mut quote_open);
            para_open = true;
            next_item += 1;
        }
    }

    let last_item = next_item.saturating_sub(1);
    let mut anchors: Vec<(f32, f32)> = Vec::new();
    if headings.first().is_none_or(|(line, _)| *line > 0) {
        anchors.push((0.0, 0.0));
    }
    for (line, item) in headings {
        let pair = (line as f32, item as f32);
        if anchors.last() != Some(&pair) {
            anchors.push(pair);
        }
    }
    let end = (last_line as f32, last_item as f32);
    if anchors.last() != Some(&end) {
        anchors.push(end);
    }
    ScrollOutline { anchors }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_preview_task_toggle, build_kb_tree, file_uri_to_path, highlights_for_preview,
        kb_heading_accent, kb_heading_size, kb_preview_palette, markdown_scroll_outline,
        preview_markdown, resolve_preview_image_path, wikilinks_for_preview,
    };
    use gpui_kit::px;
    use std::path::PathBuf;

    #[test]
    fn wikilinks_become_preview_links() {
        let md = "见 [[note]] 与 [[other|其它]]。";
        assert_eq!(
            wikilinks_for_preview(md),
            "见 [note](wiki:///note) 与 [其它](wiki:///other)。"
        );
    }

    #[test]
    fn image_wikilinks_become_markdown_images() {
        assert_eq!(
            wikilinks_for_preview("见 ![[photo.png]] 与 [[note]]。"),
            "见 ![photo.png](photo.png) 与 [note](wiki:///note)。"
        );
        assert_eq!(
            wikilinks_for_preview("![[assets/a.jpg|图]]"),
            "![图](assets/a.jpg)"
        );
    }

    #[test]
    fn relative_image_prefers_note_dir() {
        let tmp = std::env::temp_dir().join(format!("wb-kb-img-{}", std::process::id()));
        let note_dir = tmp.join("notes");
        let root = tmp.clone();
        std::fs::create_dir_all(&note_dir).unwrap();
        std::fs::write(note_dir.join("a.png"), b"note").unwrap();
        std::fs::write(root.join("a.png"), b"root").unwrap();
        let path = resolve_preview_image_path("a.png", Some(&note_dir), Some(&root)).unwrap();
        assert_eq!(path, note_dir.join("a.png"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn relative_image_falls_back_to_library_root() {
        let tmp = std::env::temp_dir().join(format!("wb-kb-img-root-{}", std::process::id()));
        let note_dir = tmp.join("notes");
        std::fs::create_dir_all(tmp.join("assets")).unwrap();
        std::fs::create_dir_all(&note_dir).unwrap();
        std::fs::write(tmp.join("assets").join("pic.png"), b"root").unwrap();
        let path =
            resolve_preview_image_path("assets/pic.png", Some(&note_dir), Some(&tmp)).unwrap();
        assert_eq!(path, tmp.join("assets").join("pic.png"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn file_uri_decodes_windows_path() {
        let path = file_uri_to_path("file:///C:/kb/a%20b.png").unwrap();
        assert_eq!(path, PathBuf::from(r"C:/kb/a b.png"));
    }

    #[test]
    fn nests_files_under_directories() {
        let entries = vec![
            ("/lib/readme.md".into(), "readme.md".into(), None),
            ("/lib/notes/a.md".into(), "notes/a.md".into(), None),
            (
                "/lib/notes/2024/b.md".into(),
                "notes\\2024\\b.md".into(),
                Some("L2 · hello".into()),
            ),
        ];
        let tree = build_kb_tree(&entries);
        assert_eq!(tree.len(), 2);
        assert!(tree[0].file_path.is_none());
        assert_eq!(tree[0].name, "notes");
        assert_eq!(tree[1].name, "readme.md");
        assert_eq!(tree[0].children.len(), 2);
        assert_eq!(tree[0].children[0].name, "2024");
        assert_eq!(tree[0].children[1].name, "a.md");
        assert_eq!(
            tree[0].children[0].children[0].snippet.as_deref(),
            Some("L2 · hello")
        );
    }

    #[test]
    fn live_outline_maps_headings_to_blocks() {
        let md = "# A\n\npara\n\n## B\n";
        let outline = markdown_scroll_outline(md);
        assert!((outline.item_for_line(0.0) - 0.0).abs() < 0.01);
        assert!((outline.item_for_line(4.0) - 2.0).abs() < 0.01);
        let mid = outline.item_for_line(2.0);
        assert!(mid > 0.4 && mid < 1.6);
        assert!((outline.line_for_item(2.0) - 4.0).abs() < 0.01);
    }

    #[test]
    fn heading_accents_follow_theme_snippet_levels() {
        assert_eq!(kb_heading_accent(1), super::hsl_css(270., 65., 58.8));
        assert_eq!(kb_heading_accent(2), super::hsl_css(330., 85., 47.2));
        assert_eq!(kb_heading_accent(3), super::hsl_css(37., 100., 50.));
        assert_eq!(kb_heading_size(1, px(16.)), px(32.));
        assert_eq!(kb_heading_size(6, px(16.)), px(19.2));
    }

    #[test]
    fn highlights_become_mark_tags() {
        assert_eq!(
            highlights_for_preview("见 ==重点== 即可。"),
            "见 <mark color=\"#ffa000\">重点</mark> 即可。"
        );
        assert_eq!(highlights_for_preview("`==raw==`"), "`==raw==`");
        assert_eq!(
            highlights_for_preview("```\n==code==\n```"),
            "```\n==code==\n```"
        );
        assert_eq!(
            preview_markdown("[[n]] 与 ==x=="),
            "[n](wiki:///n) 与 <mark color=\"#ffa000\">x</mark>"
        );
    }

    #[test]
    fn toggling_a_task_maps_through_wikilinks() {
        let source = "见 [[note]]\n- [ ] 待办\n";
        let preview = preview_markdown(source);
        let marker = preview.find("[ ]").map(|i| i..i + 3).unwrap();
        let next = apply_preview_task_toggle(source, &preview, marker, true).unwrap();
        assert_eq!(next, "见 [[note]]\n- [x] 待办\n");
    }

    #[test]
    fn preview_palette_keeps_snippet_accents() {
        let palette = kb_preview_palette(true);
        assert_eq!(palette.italic, super::hsl_css(346., 64., 57.));
        assert_eq!(palette.note, super::hsl_css(175., 45., 50.));
        assert_eq!(palette.warning, super::hsl_css(37., 100., 50.));
        assert_eq!(palette.caution, super::hsl_css(330., 85., 47.2));
    }
}
