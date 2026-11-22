use crate::state::AppState;
use gpui_kit::component::button::{Button, ButtonVariants as _, Toggle, ToggleVariants as _};
use gpui_kit::component::clipboard::Clipboard;
use gpui_kit::component::input::{Editor, EditorState, Input, InputEvent, InputState, TabSize};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::resizable::{h_resizable, resizable_panel};
use gpui_kit::component::scroll::ScrollableElement as _;
use gpui_kit::component::status_bar::StatusBar;
use gpui_kit::component::text::{TextView, TextViewState, TextViewStyle};
use gpui_kit::component::{ActiveTheme as _, Icon, IconName, Selectable as _, Sizable as _, *};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use wb_domain::{FindFlags, body_links_to, extract_wikilinks, find_spans, resolve_wikilink};
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
            _subs: Vec::new(),
        };
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
                InputEvent::PressEnter { .. } => this.find_next(window, cx),
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
        let rendered = wikilinks_for_preview(source.as_str());
        self.preview.update(cx, |state, cx| {
            state.set_text(&rendered, cx);
        });
    }

    fn preview_style(&self) -> TextViewStyle {
        if self.table_wrap {
            return TextViewStyle::default();
        }
        let mut table = StyleRefinement::default();
        table.overflow.x = Some(Overflow::Scroll);
        TextViewStyle::default().table(table)
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

    fn kb_preview(&self, entity: &WeakEntity<KnowledgePane>) -> TextView {
        let entity = entity.clone();
        TextView::new(&self.preview)
            .scrollable(true)
            .selectable(true)
            .style(self.preview_style())
            .text_size(rems(self.preview_zoom))
            .px_5()
            .py_4()
            .code_block_actions(|code_block, _window, _cx| {
                h_flex()
                    .gap_1()
                    .child(Clipboard::new("kb-copy-block").value(code_block.code()))
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
                    state.set_text(&wikilinks_for_preview(&text), cx);
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
                    out.push('[');
                    out.push_str(label);
                    out.push_str("](wiki:///");
                    out.push_str(target);
                    out.push(')');
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
                                        let reveal_path = path.clone();
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
                                            self.kb_preview(&entity),
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
                                            self.kb_preview(&entity),
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
                                                        Button::new("kb-find-go")
                                                            .xsmall()
                                                            .outline()
                                                            .label("查找")
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

#[cfg(test)]
mod tests {
    use super::{build_kb_tree, wikilinks_for_preview};

    #[test]
    fn wikilinks_become_preview_links() {
        let md = "见 [[note]] 与 [[other|其它]]。";
        assert_eq!(
            wikilinks_for_preview(md),
            "见 [note](wiki:///note) 与 [其它](wiki:///other)。"
        );
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
}
