//! 模型设置里的供应商编辑器：本机 / 自定义列表，以及右侧的连接与模型配置。

use super::settings::SettingsPane;
use crate::state::AppState;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::group_box::GroupBoxVariant;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::setting::{SettingGroup, SettingItem, SettingPage};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Value, json};
use uuid::Uuid;
use wb_agent::{load_credentials, load_providers, save_credentials, save_providers};
use wb_domain::{BUILTIN_MODEL_REF, BUILTIN_PROVIDER_ID, ProviderConfig, ProviderKind};
use wb_host::list_provider_models;

pub(crate) struct ModelEditor {
    state: AppState,
    selected_id: Option<String>,
    renaming: bool,
    key_visible: bool,
    adding_model: bool,
    fetching: bool,
    message: String,
    name_input: Entity<InputState>,
    base_url_input: Entity<InputState>,
    api_key_input: Entity<InputState>,
    model_id_input: Entity<InputState>,
}

struct ModelView {
    entity: WeakEntity<SettingsPane>,
    state: AppState,
    selected_id: Option<String>,
    renaming: bool,
    key_visible: bool,
    adding_model: bool,
    fetching: bool,
    message: String,
    name_input: Entity<InputState>,
    base_url_input: Entity<InputState>,
    api_key_input: Entity<InputState>,
    model_id_input: Entity<InputState>,
}

impl ModelEditor {
    pub(crate) fn new(
        state: AppState,
        window: &mut Window,
        cx: &mut Context<SettingsPane>,
    ) -> (Self, Vec<Subscription>) {
        let selected_id = load_providers()
            .providers
            .first()
            .map(|provider| provider.id.clone());
        let name_input = cx.new(|cx| InputState::new(window, cx).placeholder("供应商名称"));
        let base_url_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("https://api.example.com/v1"));
        let api_key_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("输入 API Key")
                .masked(true)
        });
        let model_id_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("模型 ID，例如 gpt-4o-mini"));
        let mut editor = Self {
            state,
            selected_id,
            renaming: false,
            key_visible: false,
            adding_model: false,
            fetching: false,
            message: String::new(),
            name_input,
            base_url_input,
            api_key_input,
            model_id_input,
        };
        editor.bind(window, cx);
        let subs = vec![
            cx.subscribe(&editor.base_url_input, |pane, _, event, cx| {
                if matches!(event, InputEvent::Change) {
                    pane.model_editor.commit_base_url(cx);
                }
            }),
            cx.subscribe(&editor.api_key_input, |pane, _, event, cx| {
                if matches!(event, InputEvent::Change) {
                    pane.model_editor.commit_api_key(cx);
                }
            }),
            cx.subscribe(&editor.name_input, |pane, _, event, cx| {
                if pane.model_editor.renaming
                    && matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur)
                {
                    pane.model_editor.commit_name(cx);
                }
            }),
        ];
        (editor, subs)
    }

    fn bind(&mut self, window: &mut Window, cx: &mut Context<SettingsPane>) {
        let store = load_providers();
        let creds = load_credentials();
        let Some(id) = self.selected_id.clone() else {
            return;
        };
        let Some(provider) = store.providers.iter().find(|provider| provider.id == id) else {
            return;
        };
        let title = provider_title(provider);
        let url = provider.base_url.clone();
        let key = creds.keys.get(&id).cloned().unwrap_or_default();
        let masked = !self.key_visible;
        self.name_input
            .update(cx, |input, cx| input.set_value(title, window, cx));
        self.base_url_input
            .update(cx, |input, cx| input.set_value(url, window, cx));
        self.api_key_input.update(cx, |input, cx| {
            input.set_value(key, window, cx);
            input.set_masked(masked, window, cx);
        });
    }

    fn select(&mut self, id: String, window: &mut Window, cx: &mut Context<SettingsPane>) {
        if self.selected_id.as_deref() == Some(id.as_str()) {
            return;
        }
        self.selected_id = Some(id);
        self.renaming = false;
        self.adding_model = false;
        self.key_visible = false;
        self.message.clear();
        self.bind(window, cx);
        cx.notify();
    }

    fn reload(&mut self, window: &mut Window, cx: &mut Context<SettingsPane>) {
        let store = load_providers();
        let missing = self
            .selected_id
            .as_ref()
            .is_some_and(|id| store.providers.iter().all(|provider| &provider.id != id));
        if missing {
            self.selected_id = store.providers.first().map(|provider| provider.id.clone());
        }
        self.renaming = false;
        self.adding_model = false;
        self.bind(window, cx);
        self.message = "已重新加载供应商".into();
        cx.notify();
    }

    fn add_provider(&mut self, window: &mut Window, cx: &mut Context<SettingsPane>) {
        let mut store = load_providers();
        let id = new_provider_id(&store.providers);
        store.providers.push(ProviderConfig {
            id: id.clone(),
            name: "新供应商".into(),
            kind: ProviderKind::OpenaiChatCompletions,
            base_url: String::new(),
            api_key_required: true,
            enabled: true,
            models: serde_json::Map::new(),
        });
        if let Err(err) = save_providers(&store) {
            self.message = format!("添加失败：{err}");
            cx.notify();
            return;
        }
        self.selected_id = Some(id);
        self.renaming = false;
        self.adding_model = false;
        self.key_visible = false;
        self.message.clear();
        self.bind(window, cx);
        cx.notify();
    }

    fn delete_selected(&mut self, window: &mut Window, cx: &mut Context<SettingsPane>) {
        let Some(id) = self.selected_id.clone() else {
            return;
        };
        let mut store = load_providers();
        let Some(index) = store
            .providers
            .iter()
            .position(|provider| provider.id == id)
        else {
            return;
        };
        if is_local_provider(&store.providers[index]) {
            self.message = "本机供应商不能删除".into();
            cx.notify();
            return;
        }
        store.providers.remove(index);
        if let Err(err) = save_providers(&store) {
            self.message = format!("删除失败：{err}");
            cx.notify();
            return;
        }
        let mut creds = load_credentials();
        creds.keys.remove(&id);
        if let Err(err) = save_credentials(&creds) {
            self.message = format!("供应商已删除，但密钥清理失败：{err}");
        } else {
            self.message = "已删除供应商".into();
        }
        self.selected_id = store
            .providers
            .get(index)
            .or(store.providers.last())
            .map(|provider| provider.id.clone());
        self.renaming = false;
        self.adding_model = false;
        self.key_visible = false;
        self.bind(window, cx);
        cx.notify();
    }

    fn begin_rename(&mut self, window: &mut Window, cx: &mut Context<SettingsPane>) {
        if self.selected_is_local() {
            return;
        }
        self.bind(window, cx);
        self.renaming = true;
        self.name_input
            .update(cx, |input, cx| input.focus(window, cx));
        cx.notify();
    }

    fn commit_name(&mut self, cx: &mut Context<SettingsPane>) {
        if !self.renaming {
            return;
        }
        let name = self.name_input.read(cx).value().trim().to_string();
        self.renaming = false;
        if name.is_empty() || self.selected_is_local() {
            cx.notify();
            return;
        }
        self.mutate_selected(cx, |provider| provider.name = name);
    }

    fn commit_base_url(&mut self, cx: &mut Context<SettingsPane>) {
        let Some(id) = self.selected_id.clone() else {
            return;
        };
        let url = self.base_url_input.read(cx).value().trim().to_string();
        let store = load_providers();
        let Some(provider) = store.providers.iter().find(|provider| provider.id == id) else {
            return;
        };
        if is_local_provider(provider) || provider.base_url == url {
            return;
        }
        self.mutate_selected(cx, |provider| provider.base_url = url);
    }

    fn commit_api_key(&mut self, cx: &mut Context<SettingsPane>) {
        let Some(id) = self.selected_id.clone() else {
            return;
        };
        if self.selected_is_local() {
            return;
        }
        let value = self.api_key_input.read(cx).value().trim().to_string();
        let mut creds = load_credentials();
        let current = creds.keys.get(&id).cloned().unwrap_or_default();
        if current == value {
            return;
        }
        if value.is_empty() {
            creds.keys.remove(&id);
        } else {
            creds.keys.insert(id, value);
        }
        if let Err(err) = save_credentials(&creds) {
            self.message = format!("密钥保存失败：{err}");
        }
        cx.notify();
    }

    fn toggle_key_visible(&mut self, window: &mut Window, cx: &mut Context<SettingsPane>) {
        self.key_visible = !self.key_visible;
        let masked = !self.key_visible;
        self.api_key_input
            .update(cx, |input, cx| input.set_masked(masked, window, cx));
        cx.notify();
    }

    fn set_enabled(&mut self, enabled: bool, cx: &mut Context<SettingsPane>) {
        self.mutate_selected(cx, |provider| provider.enabled = enabled);
    }

    fn set_kind(&mut self, kind: ProviderKind, cx: &mut Context<SettingsPane>) {
        self.mutate_selected(cx, |provider| {
            if !is_local_provider(provider) {
                provider.kind = kind;
            }
        });
    }

    fn set_api_key_required(&mut self, required: bool, cx: &mut Context<SettingsPane>) {
        self.mutate_selected(cx, |provider| provider.api_key_required = required);
    }

    fn set_default_model(&mut self, model_ref: String, cx: &mut Context<SettingsPane>) {
        self.state.with_mut(|inner| {
            inner.prefs.agent.default_model_ref = Some(model_ref);
        });
        self.state.persist_prefs();
        self.message = "已设为新会话的默认模型".into();
        cx.notify();
    }

    fn start_add_model(&mut self, cx: &mut Context<SettingsPane>) {
        self.adding_model = true;
        cx.notify();
    }

    fn cancel_add_model(&mut self, cx: &mut Context<SettingsPane>) {
        self.adding_model = false;
        cx.notify();
    }

    fn add_model(&mut self, window: &mut Window, cx: &mut Context<SettingsPane>) {
        let model_id = self.model_id_input.read(cx).value().trim().to_string();
        if model_id.is_empty() {
            self.message = "请填写模型 ID".into();
            cx.notify();
            return;
        }
        let Some(provider_id) = self.selected_id.clone() else {
            return;
        };
        let exists = load_providers()
            .providers
            .iter()
            .any(|provider| provider.id == provider_id && provider.models.contains_key(&model_id));
        if exists {
            self.message = format!("模型 {model_id} 已在列表中");
            cx.notify();
            return;
        }
        let inserted = model_id.clone();
        let saved = self.mutate_selected(cx, |provider| {
            provider
                .models
                .insert(inserted.clone(), model_caps(&inserted));
        });
        if !saved {
            return;
        }
        self.model_id_input
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.adding_model = false;
        self.message = format!("已添加模型 {model_id}");
        cx.notify();
    }

    fn remove_model(&mut self, model_id: String, cx: &mut Context<SettingsPane>) {
        let removed = model_id.clone();
        if self.mutate_selected(cx, |provider| {
            provider.models.remove(&removed);
        }) {
            self.message = format!("已移除模型 {model_id}");
            cx.notify();
        }
    }

    fn fetch_models(&mut self, cx: &mut Context<SettingsPane>) {
        if self.fetching {
            return;
        }
        let store = load_providers();
        let Some(id) = self.selected_id.clone() else {
            return;
        };
        let Some(provider) = store.providers.iter().find(|provider| provider.id == id) else {
            return;
        };
        if is_local_provider(provider) {
            self.message = "本机供应商不需要远程拉取".into();
            cx.notify();
            return;
        }
        if provider.base_url.trim().is_empty() {
            self.message = "先填写 Base URL".into();
            cx.notify();
            return;
        }
        let base_url = provider.base_url.clone();
        let anthropic = provider.kind == ProviderKind::AnthropicMessages;
        let key = load_credentials().keys.get(&id).cloned();
        let proxy = self.state.with(|inner| inner.prefs.http_proxy.clone());
        self.fetching = true;
        self.message = "正在获取模型…".into();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let fetched = cx
                .background_executor()
                .spawn(async move {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|err| format!("运行时创建失败：{err}"))?;
                    runtime
                        .block_on(list_provider_models(
                            &base_url,
                            key.as_deref(),
                            proxy.as_deref(),
                            anthropic,
                        ))
                        .map_err(|err| err.to_string())
                })
                .await;
            this.update(cx, |pane, cx| {
                pane.model_editor.fetching = false;
                match fetched {
                    Ok(ids) => pane.model_editor.apply_fetched(&id, ids, cx),
                    Err(err) => {
                        pane.model_editor.message = format!("获取模型失败：{err}");
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    fn apply_fetched(
        &mut self,
        provider_id: &str,
        ids: Vec<String>,
        cx: &mut Context<SettingsPane>,
    ) {
        if ids.is_empty() {
            self.message = "服务端没有返回模型".into();
            cx.notify();
            return;
        }
        let mut store = load_providers();
        let Some(provider) = store
            .providers
            .iter_mut()
            .find(|provider| provider.id == provider_id)
        else {
            self.message = "供应商已不存在".into();
            cx.notify();
            return;
        };
        let mut added = 0;
        for id in ids {
            if !provider.models.contains_key(&id) {
                provider.models.insert(id.clone(), model_caps(&id));
                added += 1;
            }
        }
        let total = provider.models.len();
        if let Err(err) = save_providers(&store) {
            self.message = format!("保存失败：{err}");
            cx.notify();
            return;
        }
        if self.selected_id.as_deref() == Some(provider_id) {
            self.message = if added == 0 {
                format!("模型列表已是最新，共 {total} 个")
            } else {
                format!("已添加 {added} 个模型，共 {total} 个")
            };
        }
        cx.notify();
    }

    fn mutate_selected(
        &mut self,
        cx: &mut Context<SettingsPane>,
        mutate: impl FnOnce(&mut ProviderConfig),
    ) -> bool {
        let Some(id) = self.selected_id.clone() else {
            return false;
        };
        let mut store = load_providers();
        let Some(provider) = store
            .providers
            .iter_mut()
            .find(|provider| provider.id == id)
        else {
            self.message = "供应商不存在，请刷新".into();
            cx.notify();
            return false;
        };
        mutate(provider);
        if let Err(err) = save_providers(&store) {
            self.message = format!("保存失败：{err}");
            cx.notify();
            return false;
        }
        cx.notify();
        true
    }

    fn selected_is_local(&self) -> bool {
        let Some(id) = self.selected_id.as_deref() else {
            return false;
        };
        load_providers()
            .providers
            .iter()
            .any(|provider| provider.id == id && is_local_provider(provider))
    }
}

pub(crate) fn model_page(entity: WeakEntity<SettingsPane>) -> SettingPage {
    let hidden = StyleRefinement::default()
        .h(px(0.))
        .min_h(px(0.))
        .max_h(px(0.))
        .p_0()
        .gap_0()
        .border_0()
        .overflow_hidden();
    SettingPage::new("模型")
        .icon(Icon::new(IconName::Cpu))
        .resettable(false)
        .header_style(&hidden)
        .group(
            SettingGroup::new()
                .variant(GroupBoxVariant::Normal)
                .in_nav(false)
                .item(
                    SettingItem::render(move |_, _, cx| render_model_settings(&entity, cx))
                        .keywords([
                            "模型",
                            "供应商",
                            "provider",
                            "Base URL",
                            "API Key",
                            "添加供应商",
                        ]),
                ),
        )
}

fn render_model_settings(entity: &WeakEntity<SettingsPane>, cx: &mut App) -> AnyElement {
    let Some(pane) = entity.upgrade() else {
        return v_flex().child("设置不可用").into_any_element();
    };
    let view = {
        let pane = pane.read(cx);
        let editor = &pane.model_editor;
        ModelView {
            entity: entity.clone(),
            state: editor.state.clone(),
            selected_id: editor.selected_id.clone(),
            renaming: editor.renaming,
            key_visible: editor.key_visible,
            adding_model: editor.adding_model,
            fetching: editor.fetching,
            message: editor.message.clone(),
            name_input: editor.name_input.clone(),
            base_url_input: editor.base_url_input.clone(),
            api_key_input: editor.api_key_input.clone(),
            model_id_input: editor.model_id_input.clone(),
        }
    };
    let providers = load_providers().providers;
    let creds = load_credentials();
    let selected = providers
        .iter()
        .find(|provider| Some(&provider.id) == view.selected_id.as_ref())
        .cloned();
    let border = cx.theme().border;

    v_flex()
        .w_full()
        .gap_4()
        .child(page_header(&view, cx))
        .child(
            h_flex()
                .w_full()
                .min_h(px(520.))
                .border_1()
                .border_color(border)
                .rounded_lg()
                .overflow_hidden()
                .items_stretch()
                .child(provider_list(&providers, &creds, &view, cx))
                .child(provider_detail(selected.as_ref(), &view, cx)),
        )
        .into_any_element()
}

fn page_header(view: &ModelView, cx: &App) -> impl IntoElement {
    let entity = view.entity.clone();
    let reload_entity = view.entity.clone();
    let muted = cx.theme().muted_foreground;
    h_flex()
        .w_full()
        .items_start()
        .justify_between()
        .gap_3()
        .child(
            v_flex()
                .gap_1()
                .min_w_0()
                .child(div().text_xl().font_semibold().child("模型设置"))
                .child(
                    div()
                        .text_sm()
                        .text_color(muted)
                        .child("管理自定义模型供应商。配置后可在聊天时选择使用。"),
                ),
        )
        .child(
            h_flex()
                .gap_2()
                .flex_shrink_0()
                .child(
                    Button::new("reload-providers")
                        .outline()
                        .icon(IconName::RefreshCw)
                        .tooltip("重新加载")
                        .on_click(move |_, window, cx| {
                            reload_entity
                                .update(cx, |pane, cx| pane.model_editor.reload(window, cx))
                                .ok();
                        }),
                )
                .child(
                    Button::new("add-provider")
                        .primary()
                        .small()
                        .icon(IconName::Plus)
                        .label("添加供应商")
                        .on_click(move |_, window, cx| {
                            entity
                                .update(cx, |pane, cx| pane.model_editor.add_provider(window, cx))
                                .ok();
                        }),
                ),
        )
}

fn provider_list(
    providers: &[ProviderConfig],
    creds: &wb_agent::CredentialStore,
    view: &ModelView,
    cx: &App,
) -> impl IntoElement {
    let border = cx.theme().border;
    let local: Vec<_> = providers
        .iter()
        .filter(|provider| is_local_provider(provider))
        .collect();
    let custom: Vec<_> = providers
        .iter()
        .filter(|provider| !is_local_provider(provider))
        .collect();
    v_flex()
        .w(px(232.))
        .flex_shrink_0()
        .h_full()
        .border_r_1()
        .border_color(border)
        .p_2()
        .gap_2()
        .child(provider_section("本机", &local, creds, view, cx, None))
        .child(provider_section(
            "自定义供应商",
            &custom,
            creds,
            view,
            cx,
            Some("还没有自定义供应商"),
        ))
}

fn provider_section(
    title: &str,
    providers: &[&ProviderConfig],
    creds: &wb_agent::CredentialStore,
    view: &ModelView,
    cx: &App,
    empty_hint: Option<&str>,
) -> impl IntoElement {
    let muted = cx.theme().muted_foreground;
    let hint = empty_hint.map(str::to_string);
    v_flex()
        .gap_1()
        .child(
            div()
                .px_2()
                .pt_1()
                .text_xs()
                .text_color(muted)
                .child(title.to_string()),
        )
        .when(providers.is_empty(), |col| {
            col.when_some(hint, |col, hint| {
                col.child(div().px_2().py_2().text_sm().text_color(muted).child(hint))
            })
        })
        .children(
            providers
                .iter()
                .map(|provider| provider_row(provider, creds, view, cx)),
        )
}

fn provider_row(
    provider: &ProviderConfig,
    creds: &wb_agent::CredentialStore,
    view: &ModelView,
    cx: &App,
) -> impl IntoElement {
    let selected = view.selected_id.as_deref() == Some(provider.id.as_str());
    let accent = cx.theme().accent;
    let has_key = creds
        .keys
        .get(&provider.id)
        .is_some_and(|key| !key.trim().is_empty());
    let color = status_color(provider, has_key, cx);
    let id = provider.id.clone();
    let entity = view.entity.clone();
    h_flex()
        .id(SharedString::from(format!("provider-row-{id}")))
        .w_full()
        .min_w_0()
        .px_2()
        .py(px(6.))
        .gap_2()
        .rounded_md()
        .items_center()
        .cursor_pointer()
        .when(selected, |row| row.bg(accent))
        .when(!selected, |row| {
            row.hover(|row| row.bg(accent.opacity(0.55)))
        })
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_sm()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(provider_title(provider)),
        )
        .child(status_dot(color))
        .on_click(move |_, window, cx| {
            let id = id.clone();
            entity
                .update(cx, |pane, cx| pane.model_editor.select(id, window, cx))
                .ok();
        })
}

fn provider_detail(
    provider: Option<&ProviderConfig>,
    view: &ModelView,
    cx: &App,
) -> impl IntoElement {
    let muted = cx.theme().muted_foreground;
    let border = cx.theme().border;
    let success = cx.theme().success;
    let Some(provider) = provider else {
        return v_flex()
            .flex_1()
            .p_4()
            .child(div().text_sm().text_color(muted).child("选择一个供应商"))
            .into_any_element();
    };
    let local = is_local_provider(provider);
    v_flex()
        .flex_1()
        .min_w_0()
        .p_4()
        .gap_4()
        .child(detail_header(provider, view, success))
        .when(local, |col| {
            col.child(
                div()
                    .text_sm()
                    .text_color(muted)
                    .child("本机模型直接在这台电脑上回答，不需要 Base URL 和 API Key。"),
            )
        })
        .when(!local, |col| {
            col.child(remote_fields(provider, view, muted))
        })
        .child(model_section(provider, view, muted, border))
        .when(!view.message.is_empty(), |col| {
            let message = view.message.clone();
            col.child(div().text_xs().text_color(muted).child(message))
        })
        .into_any_element()
}

fn detail_header(provider: &ProviderConfig, view: &ModelView, success: Hsla) -> impl IntoElement {
    let local = is_local_provider(provider);
    let enabled = provider.enabled;
    let id = provider.id.clone();
    let entity = view.entity.clone();
    let rename_entity = view.entity.clone();
    let menu_entity = view.entity.clone();
    let delete_entity = view.entity.clone();
    h_flex()
        .w_full()
        .items_center()
        .justify_between()
        .gap_2()
        .child(
            h_flex().min_w_0().gap_3().items_center().child(
                h_flex()
                    .min_w_0()
                    .gap_2()
                    .items_center()
                    .when(view.renaming && !local, |row| {
                        row.child(Input::new(&view.name_input).small().w(px(220.)))
                    })
                    .when(!view.renaming || local, |row| {
                        let title = provider_title(provider);
                        row.child(
                            div()
                                .id(SharedString::from(format!("provider-name-{id}")))
                                .max_w(px(280.))
                                .text_base()
                                .font_semibold()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .when(!local, |name| name.cursor_pointer())
                                .child(title)
                                .when(!local, |name| {
                                    name.on_click(move |_, window, cx| {
                                        rename_entity
                                            .update(cx, |pane, cx| {
                                                pane.model_editor.begin_rename(window, cx)
                                            })
                                            .ok();
                                    })
                                }),
                        )
                    })
                    .child({
                        let entity = entity.clone();
                        Switch::new(SharedString::from(format!("provider-on-{id}")))
                            .checked(enabled)
                            .small()
                            .color(success)
                            .accessibility_label("启用供应商")
                            .on_change(move |checked, _, cx| {
                                let enabled = *checked;
                                entity
                                    .update(cx, |pane, cx| {
                                        pane.model_editor.set_enabled(enabled, cx)
                                    })
                                    .ok();
                            })
                    }),
            ),
        )
        .when(!local, |row| {
            row.child(
                Button::new(SharedString::from(format!("provider-menu-{id}")))
                    .ghost()
                    .small()
                    .icon(IconName::Ellipsis)
                    .tooltip("更多")
                    .dropdown_menu_with_anchor(Anchor::BottomRight, move |menu, _, _| {
                        let rename_entity = menu_entity.clone();
                        let delete_entity = delete_entity.clone();
                        menu.item(PopupMenuItem::new("重命名").on_click(move |_, window, cx| {
                            rename_entity
                                .update(cx, |pane, cx| pane.model_editor.begin_rename(window, cx))
                                .ok();
                        }))
                        .separator()
                        .item(
                            PopupMenuItem::new("删除供应商").on_click(move |_, window, cx| {
                                delete_entity
                                    .update(cx, |pane, cx| {
                                        pane.model_editor.delete_selected(window, cx)
                                    })
                                    .ok();
                            }),
                        )
                    }),
            )
        })
}

fn remote_fields(provider: &ProviderConfig, view: &ModelView, muted: Hsla) -> impl IntoElement {
    let kind = provider.kind;
    let required = provider.api_key_required;
    let id = provider.id.clone();
    let entity = view.entity.clone();
    let key_entity = view.entity.clone();
    let kind_entity = view.entity.clone();
    v_flex()
        .gap_3()
        .child(field_label("Base URL", muted))
        .child(Input::new(&view.base_url_input).small().w_full())
        .child(field_label("API 格式", muted))
        .child(
            Button::new(SharedString::from(format!("api-kind-{id}")))
                .outline()
                .small()
                .w_full()
                .dropdown_caret(true)
                .label(kind_label(kind))
                .dropdown_menu_with_anchor(Anchor::BottomLeft, move |menu, _, _| {
                    kind_menu(menu, kind, kind_entity.clone())
                }),
        )
        .child(field_label("API Key", muted))
        .child(
            h_flex()
                .w_full()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(Input::new(&view.api_key_input).small().w_full()),
                )
                .child(
                    Button::new(SharedString::from(format!("toggle-key-{id}")))
                        .outline()
                        .small()
                        .label(if view.key_visible { "隐藏" } else { "显示" })
                        .on_click(move |_, window, cx| {
                            key_entity
                                .update(cx, |pane, cx| {
                                    pane.model_editor.toggle_key_visible(window, cx)
                                })
                                .ok();
                        }),
                ),
        )
        .child(
            Checkbox::new(SharedString::from(format!("require-key-{id}")))
                .checked(required)
                .small()
                .label("调用前必须有密钥")
                .on_change(move |checked, _, cx| {
                    let required = *checked;
                    entity
                        .update(cx, |pane, cx| {
                            pane.model_editor.set_api_key_required(required, cx)
                        })
                        .ok();
                }),
        )
}

fn kind_menu(
    menu: gpui_kit::component::menu::PopupMenu,
    current: ProviderKind,
    entity: WeakEntity<SettingsPane>,
) -> gpui_kit::component::menu::PopupMenu {
    let choices = [
        ProviderKind::OpenaiChatCompletions,
        ProviderKind::OpenaiResponses,
        ProviderKind::AnthropicMessages,
    ];
    choices.into_iter().fold(menu, |menu, kind| {
        let entity = entity.clone();
        menu.item(
            PopupMenuItem::new(kind_label(kind))
                .checked(kind == current)
                .on_click(move |_, _, cx| {
                    entity
                        .update(cx, |pane, cx| pane.model_editor.set_kind(kind, cx))
                        .ok();
                }),
        )
    })
}

fn model_section(
    provider: &ProviderConfig,
    view: &ModelView,
    muted: Hsla,
    border: Hsla,
) -> impl IntoElement {
    let local = is_local_provider(provider);
    let id = provider.id.clone();
    let entity = view.entity.clone();
    let add_entity = view.entity.clone();
    let fetch_entity = view.entity.clone();
    let mut models: Vec<_> = provider.models.iter().collect();
    models.sort_by(|left, right| left.0.cmp(right.0));
    let default_model = view.state.with(|inner| {
        inner
            .prefs
            .agent
            .default_model_ref
            .clone()
            .unwrap_or_else(|| BUILTIN_MODEL_REF.to_string())
    });

    v_flex()
        .gap_2()
        .child(
            h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .gap_2()
                .child(div().text_sm().font_semibold().child("模型列表"))
                .when(!local, |row| {
                    let fetch_entity = fetch_entity.clone();
                    let add_entity = add_entity.clone();
                    row.child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new(SharedString::from(format!("fetch-models-{id}")))
                                    .outline()
                                    .small()
                                    .disabled(view.fetching)
                                    .label(if view.fetching {
                                        "获取中…"
                                    } else {
                                        "获取模型"
                                    })
                                    .on_click(move |_, _, cx| {
                                        fetch_entity
                                            .update(cx, |pane, cx| {
                                                pane.model_editor.fetch_models(cx)
                                            })
                                            .ok();
                                    }),
                            )
                            .child(
                                Button::new("add-model")
                                    .outline()
                                    .small()
                                    .icon(IconName::Plus)
                                    .label("添加模型")
                                    .on_click(move |_, _, cx| {
                                        add_entity
                                            .update(cx, |pane, cx| {
                                                pane.model_editor.start_add_model(cx)
                                            })
                                            .ok();
                                    }),
                            ),
                    )
                }),
        )
        .when(view.adding_model && !local, |col| {
            let entity = entity.clone();
            let cancel = view.entity.clone();
            col.child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(Input::new(&view.model_id_input).small().w_full()),
                    )
                    .child(
                        Button::new("confirm-add-model")
                            .small()
                            .primary()
                            .label("添加")
                            .on_click(move |_, window, cx| {
                                entity
                                    .update(cx, |pane, cx| pane.model_editor.add_model(window, cx))
                                    .ok();
                            }),
                    )
                    .child(
                        Button::new("cancel-add-model")
                            .small()
                            .ghost()
                            .label("取消")
                            .on_click(move |_, _, cx| {
                                cancel
                                    .update(cx, |pane, cx| pane.model_editor.cancel_add_model(cx))
                                    .ok();
                            }),
                    ),
            )
        })
        .when(models.is_empty(), |col| {
            col.child(
                div()
                    .w_full()
                    .py_8()
                    .px_4()
                    .rounded_md()
                    .border_1()
                    .border_dashed()
                    .border_color(border)
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .text_sm()
                            .text_center()
                            .text_color(muted)
                            .child("当前没有配置模型，添加模型后可在聊天中使用。"),
                    ),
            )
        })
        .children(models.into_iter().map(|(model_id, caps)| {
            model_row(
                provider,
                model_id,
                caps,
                &default_model,
                local,
                border,
                &view.entity,
            )
        }))
}

fn model_row(
    provider: &ProviderConfig,
    model_id: &str,
    caps: &Value,
    default_model: &str,
    local: bool,
    border: Hsla,
    entity: &WeakEntity<SettingsPane>,
) -> impl IntoElement {
    let model_ref = format!("{}/{}", provider.id, model_id);
    let is_default = model_ref == default_model;
    let label = model_label(model_id, caps);
    let set_entity = entity.clone();
    let remove_entity = entity.clone();
    let model_ref_click = model_ref.clone();
    let remove_id = model_id.to_string();
    h_flex()
        .w_full()
        .items_center()
        .gap_2()
        .px_3()
        .py(px(6.))
        .rounded_md()
        .border_1()
        .border_color(border)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_sm()
                .overflow_hidden()
                .whitespace_nowrap()
                .text_ellipsis()
                .child(label),
        )
        .when(is_default, |row| row.child(div().text_xs().child("默认")))
        .when(!is_default, |row| {
            row.child(
                Button::new(SharedString::from(format!("default-{model_ref}")))
                    .xsmall()
                    .ghost()
                    .label("设为默认")
                    .on_click(move |_, _, cx| {
                        let model_ref_click = model_ref_click.clone();
                        set_entity
                            .update(cx, |pane, cx| {
                                pane.model_editor.set_default_model(model_ref_click, cx)
                            })
                            .ok();
                    }),
            )
        })
        .when(!local, |row| {
            row.child(
                Button::new(SharedString::from(format!("remove-{model_ref}")))
                    .xsmall()
                    .ghost()
                    .label("移除")
                    .on_click(move |_, _, cx| {
                        let remove_id = remove_id.clone();
                        remove_entity
                            .update(cx, |pane, cx| pane.model_editor.remove_model(remove_id, cx))
                            .ok();
                    }),
            )
        })
}

fn field_label(text: &'static str, muted: Hsla) -> impl IntoElement {
    div().text_sm().text_color(muted).child(text)
}

fn status_dot(color: Hsla) -> impl IntoElement {
    div().size(px(8.)).flex_shrink_0().rounded_full().bg(color)
}

fn status_color(provider: &ProviderConfig, has_key: bool, cx: &App) -> Hsla {
    if !provider.enabled {
        return cx.theme().muted_foreground;
    }
    if is_local_provider(provider) {
        return cx.theme().success;
    }
    let missing = provider.base_url.trim().is_empty() || (provider.api_key_required && !has_key);
    if missing {
        cx.theme().warning
    } else {
        cx.theme().success
    }
}

fn provider_title(provider: &ProviderConfig) -> String {
    if provider.id == BUILTIN_PROVIDER_ID
        && matches!(provider.name.as_str(), "内置" | "本地内置" | "")
    {
        "本机工作台".to_string()
    } else {
        provider.name.clone()
    }
}

fn is_local_provider(provider: &ProviderConfig) -> bool {
    provider.kind == ProviderKind::Builtin || provider.id.starts_with("builtin")
}

fn kind_label(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::Builtin => "内置",
        ProviderKind::OpenaiChatCompletions => "Chat Completions (/chat/completions)",
        ProviderKind::OpenaiResponses => "Responses (/responses)",
        ProviderKind::AnthropicMessages => "Anthropic Messages (/messages)",
    }
}

fn model_label(id: &str, caps: &Value) -> String {
    caps.get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty())
        .unwrap_or(id)
        .to_string()
}

fn model_caps(id: &str) -> Value {
    json!({
        "context": 128000,
        "output": 8192,
        "title": id,
    })
}

fn new_provider_id(existing: &[ProviderConfig]) -> String {
    loop {
        let id = format!("custom-{}", &Uuid::new_v4().simple().to_string()[..8]);
        if existing.iter().all(|provider| provider.id != id) {
            return id;
        }
    }
}
