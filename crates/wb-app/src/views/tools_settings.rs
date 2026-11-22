use super::SettingsPane;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::dialog::Dialog;
use gpui_kit::component::group_box::GroupBoxVariant;
use gpui_kit::component::setting::{SettingGroup, SettingItem, SettingPage};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use std::path::{Path, PathBuf};
use wb_host::{ToolAvailability, ToolCatalog, ToolCategory, ToolRow};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ToolListFilter {
    All,
    Ready,
    Missing,
}

pub(super) fn tools_page(
    entity: WeakEntity<SettingsPane>,
    catalog: ToolCatalog,
    filter: ToolListFilter,
    busy: bool,
) -> SettingPage {
    let mut page = SettingPage::new("工具")
        .icon(Icon::new(gpui_kit::assets::IconName::Wrench))
        .resettable(false)
        .group(header_group(entity.clone(), catalog.clone(), filter, busy));
    let any_visible = ToolCategory::all().iter().any(|category| {
        catalog
            .rows
            .iter()
            .any(|row| row.category == *category && row_visible(row, filter))
    });
    if !any_visible {
        page = page.group(empty_group());
    }
    for category in ToolCategory::all() {
        let rows: Vec<ToolRow> = catalog
            .rows
            .iter()
            .filter(|row| row.category == category)
            .cloned()
            .collect();
        let visible: Vec<ToolRow> = rows
            .iter()
            .filter(|row| row_visible(row, filter))
            .cloned()
            .collect();
        if visible.is_empty() {
            continue;
        }
        let ready = rows
            .iter()
            .filter(|row| row.availability == ToolAvailability::Installed)
            .count();
        let title = format!("{} {ready}/{}", category.label(), rows.len());
        let keywords = rows
            .iter()
            .flat_map(|row| [row.name, row.id, row.description])
            .map(str::to_string)
            .collect::<Vec<_>>();
        let group_entity = entity.clone();
        page = page.group(
            SettingGroup::new()
                .in_nav(false)
                .variant(GroupBoxVariant::Normal)
                .item(
                    SettingItem::render(move |_, _, cx| {
                        render_group(&title, &visible, group_entity.clone(), cx)
                    })
                    .keywords(keywords),
                ),
        );
    }
    page
}

fn header_group(
    entity: WeakEntity<SettingsPane>,
    catalog: ToolCatalog,
    filter: ToolListFilter,
    busy: bool,
) -> SettingGroup {
    SettingGroup::new()
        .in_nav(false)
        .variant(GroupBoxVariant::Normal)
        .item(
            SettingItem::render(move |_, _, cx| {
                let muted = cx.theme().muted_foreground;
                let ready = catalog.available_count();
                let total = catalog.rows.len();
                let scan_entity = entity.clone();
                v_flex()
                    .w_full()
                    .gap_3()
                    .child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap_3()
                            .flex_wrap()
                            .child(
                                h_flex().items_center().gap_3().child(
                                    Button::new("tools-scan")
                                        .small()
                                        .secondary()
                                        .disabled(busy)
                                        .label(if busy { "扫描中" } else { "扫描本机" })
                                        .on_click(move |_, _, cx| {
                                            scan_entity
                                                .update(cx, |this, cx| this.scan_tools(cx))
                                                .ok();
                                        }),
                                )
                                .child(
                                    div()
                                        .text_sm()
                                        .text_color(muted)
                                        .child(format!("{ready}/{total} 可用")),
                                ),
                            )
                            .child(
                                h_flex()
                                    .gap_1()
                                    .child(filter_button(
                                        "tools-filter-all",
                                        "全部",
                                        filter == ToolListFilter::All,
                                        ToolListFilter::All,
                                        entity.clone(),
                                    ))
                                    .child(filter_button(
                                        "tools-filter-ready",
                                        "可用",
                                        filter == ToolListFilter::Ready,
                                        ToolListFilter::Ready,
                                        entity.clone(),
                                    ))
                                    .child(filter_button(
                                        "tools-filter-missing",
                                        "缺失",
                                        filter == ToolListFilter::Missing,
                                        ToolListFilter::Missing,
                                        entity.clone(),
                                    )),
                            ),
                    )
                    .child(
                        div().text_sm().text_color(muted).child(
                            "第一次打开会自动获取还没装的工具，并记住结果。之后打开直接读这份记录。需要再查本机时点扫描，同时最多两个，共用 Scoop、Node 或 Python 的会排开。",
                        ),
                    )
                    .child(
                        h_flex().gap_2().flex_wrap().child(
                            div().text_sm().font_semibold().child("工具目录"),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(muted)
                                .child(catalog.tools_dir.clone()),
                        ),
                    )
                    .when(busy, |col| {
                        col.child(div().text_xs().text_color(muted).child("正在检查或获取工具…"))
                    })
            })
            .keywords(["扫描", "工具目录", "Scoop", "Node", "Python", "可用", "缺失"]),
        )
}

fn empty_group() -> SettingGroup {
    SettingGroup::new()
        .in_nav(false)
        .variant(GroupBoxVariant::Normal)
        .item(
            SettingItem::render(|_, _, cx| {
                div()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child("这个筛选下没有工具。")
            })
            .keywords(["没有工具"]),
        )
}

fn filter_button(
    id: &'static str,
    label: &'static str,
    selected: bool,
    next: ToolListFilter,
    entity: WeakEntity<SettingsPane>,
) -> impl IntoElement {
    Button::new(id)
        .xsmall()
        .when(selected, |button| button.secondary())
        .when(!selected, |button| button.outline())
        .label(label)
        .on_click(move |_, _, cx| {
            entity
                .update(cx, |this, cx| {
                    this.tool_filter = next;
                    cx.notify();
                })
                .ok();
        })
}

#[derive(Clone, Copy)]
struct ToolRowPalette {
    border: Hsla,
    fg: Hsla,
    muted: Hsla,
    accent: Hsla,
    hover: Hsla,
    radius: Pixels,
}

fn render_group(
    title: &str,
    rows: &[ToolRow],
    entity: WeakEntity<SettingsPane>,
    cx: &App,
) -> AnyElement {
    let palette = ToolRowPalette {
        border: cx.theme().border,
        fg: cx.theme().foreground,
        muted: cx.theme().muted_foreground,
        accent: cx.theme().success,
        hover: cx.theme().accent.opacity(0.35),
        radius: cx.theme().radius,
    };
    v_flex()
        .w_full()
        .gap_2()
        .child(
            div()
                .text_sm()
                .font_semibold()
                .text_color(palette.fg)
                .child(title.to_string()),
        )
        .child(
            v_flex()
                .w_full()
                .children(rows.iter().enumerate().map(|(index, row)| {
                    tool_row(
                        row.clone(),
                        index + 1 == rows.len(),
                        entity.clone(),
                        palette,
                    )
                })),
        )
        .into_any_element()
}

fn tool_row(
    row: ToolRow,
    last: bool,
    entity: WeakEntity<SettingsPane>,
    palette: ToolRowPalette,
) -> impl IntoElement {
    let ToolRowPalette {
        border,
        fg,
        muted,
        accent,
        hover,
        radius,
    } = palette;
    let id = row.id;
    let (status, installed) = status_of(&row);
    let toggle_entity = entity.clone();
    let detail_entity = entity;
    h_flex()
        .id(SharedString::from(format!("tool-row-{id}")))
        .w_full()
        .items_start()
        .gap_3()
        .px_2()
        .py_2()
        .rounded(radius)
        .hover(move |row| row.bg(hover))
        .when(!last, |row| row.border_b_1().border_color(border))
        .child(
            v_flex()
                .flex_1()
                .min_w(px(0.))
                .gap_1()
                .child(
                    h_flex()
                        .items_center()
                        .gap_2()
                        .child(Icon::new(tool_icon(id)).size(px(16.)).text_color(fg))
                        .child(
                            div()
                                .text_sm()
                                .font_semibold()
                                .text_color(fg)
                                .child(row.name),
                        ),
                )
                .child(div().text_xs().text_color(muted).child(row.description)),
        )
        .child(
            div()
                .min_w(px(72.))
                .pt(px(2.))
                .text_sm()
                .text_right()
                .text_color(if installed { accent } else { muted })
                .child(status),
        )
        .child(
            div().pt(px(1.)).child(
                Switch::new(SharedString::from(format!("tool-on-{id}")))
                    .small()
                    .checked(row.enabled)
                    .color(accent)
                    .accessibility_label(SharedString::from(format!("启用 {}", row.name)))
                    .on_click(move |checked, _, cx| {
                        let enabled = *checked;
                        toggle_entity
                            .update(cx, |this, cx| this.set_tool_enabled(id, enabled, cx))
                            .ok();
                    }),
            ),
        )
        .child(
            Button::new(SharedString::from(format!("tool-detail-{id}")))
                .outline()
                .xsmall()
                .label("详情")
                .on_click(move |_, window, cx| {
                    let detail_entity = detail_entity.clone();
                    window.open_dialog(cx, move |dialog, _, cx| {
                        let current = detail_entity
                            .upgrade()
                            .and_then(|pane| pane.read(cx).tool_catalog.row(id).cloned());
                        let busy = detail_entity
                            .upgrade()
                            .is_some_and(|pane| pane.read(cx).tools_busy);
                        tool_dialog(dialog, current, busy, detail_entity.clone())
                    });
                }),
        )
}

fn tool_dialog(
    dialog: Dialog,
    row: Option<ToolRow>,
    busy: bool,
    entity: WeakEntity<SettingsPane>,
) -> Dialog {
    let Some(row) = row else {
        return dialog.title("工具");
    };
    let (status, _) = status_of(&row);
    let name = row.name;
    let id = row.id;
    let fetchable = row.fetchable && row.availability != ToolAvailability::Installed;
    let location = row.location.clone();
    let open_location = location.clone().filter(|path| PathBuf::from(path).exists());
    dialog
        .title(name)
        .child(
            v_flex()
                .w_full()
                .gap_2()
                .px_4()
                .child(div().text_sm().child(row.description))
                .child(detail_line("状态", status))
                .child(detail_line(
                    "版本",
                    row.version.unwrap_or_else(|| "—".into()),
                ))
                .child(detail_line("位置", location.unwrap_or_else(|| "—".into())))
                .child(detail_line("获取", row.lane_label))
                .child(
                    v_flex()
                        .w_full()
                        .gap_1()
                        .pt_2()
                        .child(div().text_sm().font_semibold().child("安装介绍"))
                        .child(div().text_sm().child(row.install_guide)),
                )
                .when_some(row.message, |col, message| {
                    col.child(div().text_sm().child(message))
                }),
        )
        .footer(
            h_flex()
                .w_full()
                .justify_end()
                .gap_2()
                .px_4()
                .pb_2()
                .when_some(open_location, |row, path| {
                    row.child(
                        Button::new("tool-open-location")
                            .small()
                            .label("打开位置")
                            .on_click(move |_, _, cx| {
                                let path = PathBuf::from(&path);
                                let target = if path.is_file() {
                                    path.parent().map(Path::to_path_buf).unwrap_or(path)
                                } else {
                                    path
                                };
                                cx.open_with_system(&target);
                            }),
                    )
                })
                .when(fetchable, |row| {
                    let entity = entity.clone();
                    row.child(
                        Button::new("tool-fetch")
                            .small()
                            .primary()
                            .disabled(busy)
                            .label("获取")
                            .on_click(move |_, window, cx| {
                                entity.update(cx, |this, cx| this.fetch_tool(id, cx)).ok();
                                window.close_dialog(cx);
                            }),
                    )
                })
                .child(
                    Button::new("tool-detail-close")
                        .small()
                        .label("关闭")
                        .on_click(|_, window, cx| {
                            window.close_dialog(cx);
                        }),
                ),
        )
}

fn detail_line(label: &'static str, value: impl Into<SharedString>) -> impl IntoElement {
    let value = value.into();
    h_flex()
        .w_full()
        .gap_3()
        .items_start()
        .child(div().w(px(48.)).text_sm().child(label))
        .child(div().flex_1().text_sm().child(value))
}

fn tool_icon(id: &str) -> gpui_kit::assets::IconName {
    use gpui_kit::assets::IconName::{
        AppWindow, Binary, Box, Braces, ChartArea, ChartBar, ChartLine, Chrome, Clapperboard, Code,
        Coffee, Cog, Database, FileCode, FileText, FolderSync, Gem, Hash, Layers, Monitor,
        MousePointer, Package, PackagePlus, Pen, PenTool, ScanText, Search, Terminal, Type,
        Workflow,
    };
    match id {
        "uv" => Box,
        "node" => FileCode,
        "git" => gpui_kit::assets::IconName::GitBranch,
        "ripgrep" => Search,
        "chromium" => Chrome,
        "playwright" => Monitor,
        "browser-mcp" => MousePointer,
        "poppler" => FileText,
        "cairo" => PenTool,
        "mermaid" => Workflow,
        "fontwasm" => Type,
        "pp-ocr" => ScanText,
        "inkscape" => Pen,
        "ffmpeg" => Clapperboard,
        "openssh" => Terminal,
        "sshfs" => FolderSync,
        "go" => Code,
        "java-maven" => Coffee,
        "rust" => Cog,
        "ruby" => Gem,
        "php" => Hash,
        "dotnet" => Layers,
        "webview2" => AppWindow,
        "redis" => Database,
        "nsis" => Package,
        "inno" => PackagePlus,
        "readelf" => Binary,
        "matplotlib" => ChartLine,
        "plotly" => ChartBar,
        "altair" => ChartArea,
        "bokeh" => Braces,
        _ => Cog,
    }
}

fn status_of(row: &ToolRow) -> (&'static str, bool) {
    if row.busy {
        return ("获取中", false);
    }
    match row.availability {
        ToolAvailability::Installed => ("已安装", true),
        ToolAvailability::Missing => ("未安装", false),
        ToolAvailability::Failed => ("获取失败", false),
    }
}

fn row_visible(row: &ToolRow, filter: ToolListFilter) -> bool {
    match filter {
        ToolListFilter::All => true,
        ToolListFilter::Ready => row.availability == ToolAvailability::Installed,
        ToolListFilter::Missing => row.availability != ToolAvailability::Installed,
    }
}
