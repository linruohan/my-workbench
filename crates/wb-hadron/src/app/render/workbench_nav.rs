//! 工作台左侧导航。
//!
//! 宿主（wb-app）只注入「分组 + 条目 + 点击回调」，具体的视觉由 chamber
//! 用 hadron 的深色玻璃风格绘制。这样左中右三栏共享同一套皮肤，宿主不必
//! 再维护一份 gpui-kit 浅色侧边栏，也避免两边样式长期漂移。

use super::*;

/// 导航条目的语义图标。宿主只描述「这是什么」，映射到什么图标由 chamber 决定。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkbenchNavIcon {
    Today,
    Inbox,
    Done,
    Planner,
    Timed,
    Tags,
    Project,
    Knowledge,
    Agent,
    Session,
    Settings,
    NewProject,
    /// 行尾「更多」按钮（目前用于重命名会话）。
    More,
    /// 折叠/展开箭头。
    ChevronRight,
    ChevronDown,
}

impl WorkbenchNavIcon {
    /// 把语义图标映射成 hadron 主题里已有的 Lucide 图标。
    fn icon_name(self) -> IconName {
        match self {
            Self::Today | Self::Planner => IconName::Calendar,
            Self::Inbox => IconName::Inbox,
            Self::Done => IconName::Check,
            Self::Timed => IconName::SquareTerminal,
            Self::Tags => IconName::Star,
            Self::Project => IconName::Folder,
            Self::Knowledge => IconName::BookOpen,
            Self::Agent => IconName::Bot,
            Self::Session => IconName::FileText,
            Self::Settings => IconName::Settings,
            Self::NewProject => IconName::Plus,
            Self::More => IconName::Ellipsis,
            Self::ChevronRight => IconName::ChevronRight,
            Self::ChevronDown => IconName::ChevronDown,
        }
    }
}

/// 左栏的一行导航。
#[derive(Clone, Debug)]
pub struct WorkbenchNavItem {
    /// 宿主的页面标识，点击时原样回传。
    pub id: String,
    pub label: String,
    pub icon: WorkbenchNavIcon,
    /// 行尾的数字徽标（为 0 或 None 时不画）。
    pub badge: Option<usize>,
    pub active: bool,
    /// 是否作为子项缩进显示（例如工作区下面的会话行）。
    pub indent: bool,
    /// 行尾动作按钮：(回传给宿主的 id, 图标)。点击时不会触发整行点击。
    pub action: Option<(String, WorkbenchNavIcon)>,
}

impl WorkbenchNavItem {
    /// 新建一行导航；默认未选中、无徽标、不缩进、无行尾动作。
    pub fn new(id: impl Into<String>, label: impl Into<String>, icon: WorkbenchNavIcon) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon,
            badge: None,
            active: false,
            indent: false,
            action: None,
        }
    }

    /// 设置行尾计数徽标（0 会被忽略）。
    pub fn badge(mut self, count: usize) -> Self {
        self.badge = Some(count);
        self
    }

    /// 设置当前是否选中（决定高亮底色与图标强调色）。
    pub fn active(mut self, active: bool) -> Self {
        self.active = active;
        self
    }

    /// 标记为子项：渲染时整体左缩进，用来表达「会话挂在某个工作区下」。
    pub fn indent(mut self, indent: bool) -> Self {
        self.indent = indent;
        self
    }

    /// 在行尾挂一个动作按钮（例如会话行的「更多」→ 重命名）。
    pub fn action(mut self, id: impl Into<String>, icon: WorkbenchNavIcon) -> Self {
        self.action = Some((id.into(), icon));
        self
    }
}

/// 带标题的一组导航条目，标题右侧可挂一个「+」类动作。
#[derive(Clone, Debug)]
pub struct WorkbenchNavGroup {
    pub title: String,
    pub items: Vec<WorkbenchNavItem>,
    /// 组标题右侧的动作按钮：(回传给宿主的 id, 图标)。
    pub action: Option<(String, WorkbenchNavIcon)>,
}

impl WorkbenchNavGroup {
    /// 新建一个空分组。
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            items: Vec::new(),
            action: None,
        }
    }

    /// 一次性填入分组内的条目。
    pub fn items(mut self, items: Vec<WorkbenchNavItem>) -> Self {
        self.items = items;
        self
    }

    /// 在组标题右侧挂一个动作按钮（例如「新建项目」）。
    pub fn action(mut self, id: impl Into<String>, icon: WorkbenchNavIcon) -> Self {
        self.action = Some((id.into(), icon));
        self
    }
}

impl Chamber {
    /// 注入左侧导航内容：分组列表 + 底部固定项（账户/设置）。
    ///
    /// 宿主每次渲染前调用即可；这里只保存快照，不触发额外重绘。
    pub fn set_workbench_nav(
        &mut self,
        groups: Vec<WorkbenchNavGroup>,
        footer: Option<WorkbenchNavItem>,
    ) {
        self.workbench_nav_groups = groups;
        self.workbench_nav_footer = footer;
    }

    /// 注入导航点击回调；chamber 不感知宿主有什么页面。
    pub fn set_workbench_nav_handler<F>(&mut self, handler: F)
    where
        F: Fn(&str, &mut Window, &mut App) + 'static,
    {
        self.workbench_nav_select = Some(Box::new(handler));
    }

    /// 把一次导航点击转交给宿主，并重绘选中态。
    ///
    /// 会话/工作区动作一律交给宿主处理：宿主会用 `cx.defer_in` 延后一帧再操作
    /// chamber，避免在 chamber 自己的点击回调里对同一个 Entity 重入借用。
    fn select_workbench_nav(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(handler) = self.workbench_nav_select.as_ref() {
            handler(id, window, cx);
        }
        cx.notify();
    }

    /// 嵌入模式的左侧栏：分组导航 + 底部账户/设置。
    ///
    /// `collapsed` 为真时只留图标列，与宿主的分栏宽度（48px）配合使用。
    /// 宽度与拖拽由宿主的 `resizable_panel` 控制，这里只负责内容本身。
    pub fn render_sidebar_surface(
        &mut self,
        collapsed: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let groups = self.workbench_nav_groups.clone();
        let footer = self.workbench_nav_footer.clone();

        let mut column = v_flex()
            .size_full()
            .min_h_0()
            .gap_1()
            .p_2()
            .overflow_hidden()
            // 与聊天区/右栏同一块深色底，保证三栏是一套皮肤。
            .bg(theme::bg_base())
            .text_color(theme::text());

        if !collapsed {
            column = column.child(
                h_flex()
                    .flex_none()
                    .h_7()
                    .px_1()
                    .items_center()
                    .gap_2()
                    .text_xs()
                    .font_weight(gpui_kit::FontWeight::BOLD)
                    .text_color(theme::text_muted())
                    .child(Icon::new(IconName::LayoutDashboard).small())
                    .child("工作台"),
            );
        }

        let mut body = v_flex()
            .id("wb-nav-scroll")
            .flex_1()
            .min_h_0()
            .gap_3()
            .overflow_y_scroll();
        for group in &groups {
            body = body.child(self.render_nav_group(group, collapsed, cx));
        }
        column = column.child(body);

        if let Some(item) = footer.as_ref() {
            column = column.child(self.render_nav_row(item, collapsed, cx));
        }
        column
    }

    /// 画一个导航分组：标题（含可选动作按钮）+ 若干行。
    fn render_nav_group(
        &self,
        group: &WorkbenchNavGroup,
        collapsed: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mut column = v_flex().w_full().gap_0p5();

        // 空标题表示「无分组」的平级条目（知识库 / 定时任务 / Agent）。
        if !collapsed && !group.title.is_empty() {
            let mut header = h_flex()
                .flex_none()
                .px_2()
                .pt_1()
                .pb_1()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_xs()
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .text_color(theme::text_muted())
                        .child(group.title.clone()),
                );
            if let Some((action_id, icon)) = group.action.clone() {
                header = header.child(
                    div()
                        .id(SharedString::from(format!("wb-nav-action-{action_id}")))
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .size(px(18.))
                        .rounded_sm()
                        .cursor_pointer()
                        .hover(|s| s.bg(theme::bg_surface_raised()))
                        .child(Icon::new(icon.icon_name()).xsmall())
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.select_workbench_nav(&action_id, window, cx);
                        })),
                );
            }
            column = column.child(header);
        }

        for item in &group.items {
            column = column.child(self.render_nav_row(item, collapsed, cx));
        }
        column
    }

    /// 画一行导航：图标 + 标签 + 可选徽标；选中态用抬升底色 + 细高光边。
    fn render_nav_row(
        &self,
        item: &WorkbenchNavItem,
        collapsed: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let nav_id = item.id.clone();
        let active = item.active;
        let badge = item.badge.filter(|count| *count > 0);

        let mut row = h_flex()
            .id(SharedString::from(format!("wb-nav-{}", item.id)))
            .flex_none()
            .h_8()
            .w_full()
            .items_center()
            .gap_2()
            .px_2()
            .rounded_md()
            .border_1()
            .border_color(if active {
                theme::glass_highlight()
            } else {
                gpui_kit::Hsla::transparent_black()
            })
            .bg(if active {
                theme::bg_surface_raised()
            } else {
                rgba(0x00000000)
            })
            .cursor_pointer()
            .hover(|s| s.bg(theme::bg_surface()))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(px(24.))
                    .text_color(if active {
                        theme::accent()
                    } else {
                        theme::text_muted()
                    })
                    .child(Icon::new(item.icon.icon_name()).small()),
            );

        if !collapsed {
            row = row.child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_sm()
                    .text_color(if active {
                        theme::text()
                    } else {
                        theme::text_secondary()
                    })
                    .child(item.label.clone()),
            );
            if let Some(count) = badge {
                row = row.child(
                    div()
                        .flex_none()
                        .px_1p5()
                        .rounded_full()
                        .bg(theme::bg_surface_raised())
                        .text_xs()
                        .text_color(theme::text_muted())
                        .child(count.to_string()),
                );
            }
            // 行尾「更多」：只在展开态显示，点击时吞掉事件，避免顺带切换会话。
            if let Some((action_id, icon)) = item.action.clone() {
                let action_id = action_id.clone();
                row = row.child(
                    div()
                        .id(SharedString::from(format!("wb-nav-row-action-{action_id}")))
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .size(px(18.))
                        .rounded_sm()
                        .cursor_pointer()
                        .hover(|s| s.bg(theme::bg_surface_raised()))
                        .child(
                            Icon::new(icon.icon_name())
                                .xsmall()
                                .text_color(theme::text_muted()),
                        )
                        .on_click(cx.listener(move |this, _, window, cx| {
                            // 动作按钮与整行点击互斥：先阻止冒泡再转交宿主。
                            cx.stop_propagation();
                            this.select_workbench_nav(&action_id, window, cx);
                        })),
                );
            }
        }

        row.when(item.indent && !collapsed, |this| this.pl_5())
            .when(collapsed, |this| this.justify_center().px_0())
            .on_click(cx.listener(move |this, _, window, cx| {
                this.select_workbench_nav(&nav_id, window, cx);
            }))
    }
}
