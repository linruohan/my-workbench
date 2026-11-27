//! 任务新建 / 查看 / 编辑共用的弹窗表单。

use crate::state::AppState;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::calendar::Date;
use gpui_kit::component::date_picker::{DatePicker, DatePickerEvent, DatePickerState, DateTime};
use gpui_kit::component::dialog::Confirm;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::tag::Tag;
use gpui_kit::component::time_field::TimePrecision;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use wb_domain::{
    INBOX_PROJECT_ID, ReminderOptionId, Task, TimedSchedulePreset, at_local_time,
    create_task_draft, mark_task_complete, mark_task_incomplete,
    milliseconds_diff_to_remind_option, now_ms, remind_option_label, set_task_repeat_preset,
    shift_remind_at, task_repeat_preset,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskStatus {
    Todo,
    Doing,
    Done,
}

impl TaskStatus {
    fn label(self) -> &'static str {
        match self {
            Self::Todo => "待办",
            Self::Doing => "进行中",
            Self::Done => "已完成",
        }
    }

    fn from_task(task: &Task) -> Self {
        if task.is_done {
            Self::Done
        } else if task.due_day.is_some() || task.due_with_time.is_some() {
            Self::Doing
        } else {
            Self::Todo
        }
    }
}

pub struct TaskForm {
    state: AppState,
    task_id: Option<String>,
    project_id: String,
    status: TaskStatus,
    repeat: Option<TimedSchedulePreset>,
    repeat_open: bool,
    tag_ids: Vec<String>,
    pending_subtasks: Vec<String>,
    title: Entity<InputState>,
    notes: Entity<InputState>,
    subtask: Entity<InputState>,
    tag_input: Entity<InputState>,
    start: Entity<DatePickerState>,
    deadline: Entity<DatePickerState>,
    plan_remind: ReminderOptionId,
    deadline_remind: ReminderOptionId,
    _subs: Vec<Subscription>,
}

impl TaskForm {
    pub fn new(state: AppState, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let title = cx.new(|cx| InputState::new(window, cx).placeholder("任务标题"));
        let notes = cx.new(|cx| InputState::new(window, cx).placeholder("补充说明、清单或上下文"));
        let subtask = cx.new(|cx| InputState::new(window, cx).placeholder("添加子任务，回车确认"));
        let tag_input = cx.new(|cx| InputState::new(window, cx).placeholder("新标签，回车添加"));
        let start = cx.new(|cx| {
            DatePickerState::new(window, cx)
                .time_precision(TimePrecision::Minute)
                .date_format("%Y年%m月%d日 %H:%M")
        });
        let deadline = cx.new(|cx| {
            DatePickerState::new(window, cx)
                .time_precision(TimePrecision::Minute)
                .date_format("%Y年%m月%d日 %H:%M")
        });
        let mut this = Self {
            state,
            task_id: None,
            project_id: INBOX_PROJECT_ID.to_string(),
            status: TaskStatus::Todo,
            repeat: None,
            repeat_open: false,
            tag_ids: Vec::new(),
            pending_subtasks: Vec::new(),
            title: title.clone(),
            notes: notes.clone(),
            subtask: subtask.clone(),
            tag_input: tag_input.clone(),
            start: start.clone(),
            deadline,
            plan_remind: ReminderOptionId::None,
            deadline_remind: ReminderOptionId::None,
            _subs: Vec::new(),
        };
        this._subs.push(
            cx.subscribe_in(&subtask, window, |this, input, event, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    // 单行输入会把 Enter 继续交给对话框的确认动作，窗口会因此关掉。
                    cx.stop_propagation();
                    let text = input.read(cx).value().to_string();
                    if !text.trim().is_empty() {
                        this.add_subtask(text.trim(), cx);
                        input.update(cx, |input, cx| input.set_value("", window, cx));
                    }
                }
            }),
        );
        this._subs.push(
            cx.subscribe_in(&tag_input, window, |this, input, event, window, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    let text = input.read(cx).value().to_string();
                    if !text.trim().is_empty() {
                        this.add_tag(text.trim(), cx);
                        input.update(cx, |input, cx| input.set_value("", window, cx));
                    }
                }
            }),
        );
        this._subs
            .push(cx.subscribe_in(&start, window, |this, _, event, _, cx| {
                let DatePickerEvent::Change(value) = event;
                if this.status == TaskStatus::Done {
                    return;
                }
                let next = if value.start().is_some() {
                    TaskStatus::Doing
                } else {
                    TaskStatus::Todo
                };
                if this.status != next {
                    this.status = next;
                    cx.notify();
                }
            }));
        this
    }

    pub fn is_editing(&self) -> bool {
        self.task_id.is_some()
    }

    pub fn focus_title(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.title.update(cx, |input, cx| input.focus(window, cx));
    }

    pub fn subtitle(&self, cx: &App) -> String {
        let created = self.task_id.as_ref().and_then(|id| {
            self.state
                .with(|s| s.repo.get_task(id).map(|task| task.created_at))
        });
        let deadline = picker_ms(&self.deadline, cx);
        match (created, deadline) {
            (Some(created), Some(deadline)) => {
                format!("{} · 截止 {}", format_cn(created), format_cn(deadline))
            }
            (Some(created), None) => format_cn(created),
            (None, Some(deadline)) => format!("截止 {}", format_cn(deadline)),
            (None, None) => "填写标题后保存".into(),
        }
    }

    pub fn load_new(&mut self, project_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.task_id = None;
        self.project_id = if project_id.is_empty() {
            INBOX_PROJECT_ID.to_string()
        } else {
            project_id.to_string()
        };
        self.status = TaskStatus::Todo;
        self.repeat = None;
        self.repeat_open = false;
        self.tag_ids.clear();
        self.pending_subtasks.clear();
        self.title
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.notes
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.subtask
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.tag_input
            .update(cx, |input, cx| input.set_value("", window, cx));
        write_picker(&self.start, None, window, cx);
        write_picker(&self.deadline, None, window, cx);
        let default_remind = self.default_remind();
        self.plan_remind = default_remind;
        self.deadline_remind = default_remind;
        cx.notify();
    }

    fn default_remind(&self) -> ReminderOptionId {
        let raw = self.state.with(|s| s.prefs.general.default_remind.clone());
        ReminderOptionId::parse(&raw).unwrap_or(ReminderOptionId::M15)
    }

    pub fn load_existing(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let loaded = self.state.with(|s| {
            s.repo.get_task(id).cloned().map(|task| {
                let tags = s
                    .repo
                    .tags_for_task(&task.id)
                    .into_iter()
                    .map(|tag| tag.id)
                    .collect::<Vec<_>>();
                (task, tags)
            })
        });
        let Some((task, tags)) = loaded else {
            return;
        };
        let start_ms = task.due_with_time.or_else(|| {
            task.due_day
                .as_deref()
                .and_then(|day| at_local_time(day, 9, 0))
        });
        let deadline_ms = task.deadline_with_time.or_else(|| {
            task.deadline_day
                .as_deref()
                .and_then(|day| at_local_time(day, 18, 0))
        });
        self.task_id = Some(task.id.clone());
        self.project_id = task.project_id.clone();
        self.status = TaskStatus::from_task(&task);
        self.repeat = task_repeat_preset(&task);
        self.repeat_open = self.repeat.is_some();
        self.plan_remind = remind_option_of(start_ms, task.remind_at);
        self.deadline_remind = remind_option_of(deadline_ms, task.deadline_remind_at);
        self.tag_ids = tags;
        self.pending_subtasks.clear();
        self.title.update(cx, |input, cx| {
            input.set_value(task.title.clone(), window, cx)
        });
        self.notes.update(cx, |input, cx| {
            input.set_value(task.notes.clone(), window, cx)
        });
        self.subtask
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.tag_input
            .update(cx, |input, cx| input.set_value("", window, cx));
        write_picker(&self.start, start_ms, window, cx);
        write_picker(&self.deadline, deadline_ms, window, cx);
        cx.notify();
    }

    pub fn set_project(&mut self, project_id: String, cx: &mut Context<Self>) {
        self.project_id = project_id;
        cx.notify();
    }

    fn set_status(&mut self, status: TaskStatus, window: &mut Window, cx: &mut Context<Self>) {
        self.status = status;
        match status {
            TaskStatus::Todo => write_picker(&self.start, None, window, cx),
            TaskStatus::Doing if picker_ms(&self.start, cx).is_none() => {
                write_picker(&self.start, Some(now_ms()), window, cx);
            }
            TaskStatus::Doing | TaskStatus::Done => {}
        }
        cx.notify();
    }

    pub fn set_repeat(&mut self, preset: Option<TimedSchedulePreset>, cx: &mut Context<Self>) {
        self.repeat = preset;
        self.repeat_open = true;
        cx.notify();
    }

    pub fn set_plan_remind(&mut self, option: ReminderOptionId, cx: &mut Context<Self>) {
        self.plan_remind = option;
        cx.notify();
    }

    pub fn set_deadline_remind(&mut self, option: ReminderOptionId, cx: &mut Context<Self>) {
        self.deadline_remind = option;
        cx.notify();
    }

    pub fn toggle_repeat(&mut self, cx: &mut Context<Self>) {
        self.repeat_open = !self.repeat_open;
        cx.notify();
    }

    pub fn toggle_tag(&mut self, tag_id: &str, cx: &mut Context<Self>) {
        if self.tag_ids.iter().any(|id| id == tag_id) {
            self.remove_tag(tag_id, cx);
        } else {
            self.attach_tag(tag_id, cx);
        }
    }

    pub fn save(&mut self, cx: &mut Context<Self>) -> bool {
        let title = self.title.read(cx).value().trim().to_string();
        if title.is_empty() {
            return false;
        }
        let notes = self.notes.read(cx).value().to_string();
        let start_ms = match self.status {
            TaskStatus::Doing => picker_ms(&self.start, cx).or_else(|| Some(now_ms())),
            TaskStatus::Todo | TaskStatus::Done => picker_ms(&self.start, cx),
        };
        let deadline_ms = picker_ms(&self.deadline, cx);
        let project_id = self.project_id.clone();
        let status = self.status;
        let repeat = self.repeat;
        let tag_ids = self.tag_ids.clone();
        let plan_remind = self.plan_remind;
        let deadline_remind = self.deadline_remind;
        let pending = self.pending_subtasks.clone();
        let existing_id = self.task_id.clone();

        let saved_id = self.state.with_mut(|s| {
            let mut task = if let Some(id) = existing_id.as_deref() {
                s.repo
                    .get_task(id)
                    .cloned()
                    .unwrap_or_else(|| create_task_draft(&title, Some(&project_id), None, None))
            } else {
                create_task_draft(&title, Some(&project_id), None, None)
            };
            task.title = title;
            task.notes = notes;
            task.project_id = project_id.clone();
            if start_ms.is_some() {
                task.due_with_time = start_ms;
                task.due_day = None;
            } else {
                task.due_with_time = None;
                task.due_day = None;
            }
            if deadline_ms.is_some() {
                task.deadline_with_time = deadline_ms;
                task.deadline_day = None;
            } else {
                task.deadline_with_time = None;
                task.deadline_day = None;
            }
            task.remind_at = start_ms.and_then(|due| shift_remind_at(due, plan_remind));
            task.deadline_remind_at =
                deadline_ms.and_then(|due| shift_remind_at(due, deadline_remind));
            let now = now_ms();
            match status {
                TaskStatus::Done if !task.is_done => mark_task_complete(&mut task, now),
                TaskStatus::Todo | TaskStatus::Doing if task.is_done => {
                    mark_task_incomplete(&mut task, now);
                }
                _ => task.updated_at = now,
            }
            let _ = set_task_repeat_preset(&mut task, repeat);
            let id = task.id.clone();
            s.repo.upsert_task(task);
            let current = s.repo.tags_for_task(&id);
            for tag in &current {
                if !tag_ids.iter().any(|kept| kept == &tag.id) {
                    s.repo.remove_tag_from_task(&id, &tag.id);
                }
            }
            for tag_id in &tag_ids {
                s.repo.add_tag_to_task(&id, tag_id);
            }
            if existing_id.is_none() {
                for child_title in &pending {
                    let child = create_task_draft(child_title, Some(&project_id), Some(&id), None);
                    s.repo.upsert_task(child);
                }
            }
            id
        });
        self.task_id = Some(saved_id);
        self.pending_subtasks.clear();
        self.state.persist_if_dirty();
        cx.notify();
        true
    }

    pub fn delete(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(id) = self.task_id.clone() else {
            return true;
        };
        self.state.with_mut(|s| {
            s.repo.delete_task(&id);
            if s.selected_task_id.as_deref() == Some(id.as_str()) {
                s.selected_task_id = None;
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
        true
    }

    pub fn duplicate(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.save(cx) {
            return false;
        }
        let Some(id) = self.task_id.clone() else {
            return false;
        };
        self.state.with_mut(|s| {
            let Some(task) = s.repo.get_task(&id).cloned() else {
                return;
            };
            let tags = s.repo.tags_for_task(&id);
            let mut copy = create_task_draft(
                &format!("{} 副本", task.title.trim()),
                Some(&task.project_id),
                task.parent_id.as_deref(),
                None,
            );
            copy.notes = task.notes.clone();
            copy.due_day = task.due_day.clone();
            copy.due_with_time = task.due_with_time;
            copy.deadline_day = task.deadline_day.clone();
            copy.deadline_with_time = task.deadline_with_time;
            copy.remind_at = task.remind_at;
            copy.deadline_remind_at = task.deadline_remind_at;
            copy.repeat_cfg_id = task.repeat_cfg_id.clone();
            copy.time_estimate = task.time_estimate;
            let copy_id = copy.id.clone();
            s.repo.upsert_task(copy);
            for tag in tags {
                s.repo.add_tag_to_task(&copy_id, &tag.id);
            }
        });
        self.state.persist_if_dirty();
        cx.notify();
        true
    }

    fn add_tag(&mut self, title: &str, cx: &mut Context<Self>) {
        let title = title.trim();
        if title.is_empty() {
            return;
        }
        let id = self.state.with_mut(|s| s.repo.create_tag(title).id);
        self.attach_tag(&id, cx);
        self.state.persist_if_dirty();
    }

    /// 把标签挂到当前表单。已保存的任务会立刻写入绑定。
    fn attach_tag(&mut self, tag_id: &str, cx: &mut Context<Self>) {
        if !self.tag_ids.iter().any(|id| id == tag_id) {
            self.tag_ids.push(tag_id.to_string());
        }
        if let Some(task_id) = self.task_id.clone() {
            self.state
                .with_mut(|s| s.repo.add_tag_to_task(&task_id, tag_id));
            self.state.persist_if_dirty();
        }
        cx.notify();
    }

    /// 从当前任务拿掉标签。已保存的任务会立刻解除绑定，标签本身仍留在标签库。
    fn remove_tag(&mut self, tag_id: &str, cx: &mut Context<Self>) {
        self.tag_ids.retain(|id| id != tag_id);
        if let Some(task_id) = self.task_id.clone() {
            self.state
                .with_mut(|s| s.repo.remove_tag_from_task(&task_id, tag_id));
            self.state.persist_if_dirty();
        }
        cx.notify();
    }

    fn bound_tags(&self) -> Vec<(String, String)> {
        self.state.with(|s| {
            let tags = s.repo.list_tags();
            self.tag_ids
                .iter()
                .filter_map(|id| {
                    tags.iter()
                        .find(|tag| &tag.id == id)
                        .map(|tag| (tag.id.clone(), tag.title.clone()))
                })
                .collect()
        })
    }

    fn add_subtask(&mut self, title: &str, cx: &mut Context<Self>) {
        if let Some(parent_id) = self.task_id.clone() {
            let project_id = self.project_id.clone();
            self.state.with_mut(|s| {
                let child = create_task_draft(title, Some(&project_id), Some(&parent_id), None);
                s.repo.upsert_task(child);
            });
            self.state.persist_if_dirty();
        } else {
            self.pending_subtasks.push(title.to_string());
        }
        cx.notify();
    }

    fn project_label(&self) -> String {
        self.state.with(|s| {
            s.repo
                .list_projects()
                .into_iter()
                .find(|project| project.id == self.project_id)
                .map(|project| project.title)
                .unwrap_or_else(|| "收件箱".into())
        })
    }

    fn tag_label(&self) -> String {
        if self.tag_ids.is_empty() {
            return "选择或新建标签".into();
        }
        self.state.with(|s| {
            let titles: Vec<String> = self
                .tag_ids
                .iter()
                .filter_map(|id| s.repo.list_tags().into_iter().find(|tag| &tag.id == id))
                .map(|tag| format!("#{}", tag.title))
                .collect();
            if titles.is_empty() {
                "选择或新建标签".into()
            } else {
                titles.join(" ")
            }
        })
    }

    fn repeat_label(&self) -> String {
        match self.repeat {
            Some(TimedSchedulePreset::Daily) => "每天".into(),
            Some(TimedSchedulePreset::Weekdays) => "工作日".into(),
            Some(TimedSchedulePreset::Weekly) => "每周".into(),
            Some(TimedSchedulePreset::Monthly) => "每月".into(),
            Some(TimedSchedulePreset::Hourly) => "每小时".into(),
            None => "+ 添加重复".into(),
        }
    }
}

impl Render for TaskForm {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let form = cx.weak_entity();
        let muted = cx.theme().muted_foreground;
        let border = cx.theme().border;
        let radius = cx.theme().radius;
        let project_label = self.project_label();
        let status_label = self.status.label();
        let tag_label = self.tag_label();
        let repeat_label = self.repeat_label();
        let status = self.status;
        let plan_remind = self.plan_remind;
        let deadline_remind = self.deadline_remind;
        let repeat = self.repeat;
        let project_id = self.project_id.clone();
        let tag_ids = self.tag_ids.clone();
        let bound_tags = self.bound_tags();
        let subtasks = self.subtask_rows();
        let danger = cx.theme().danger;

        v_flex()
            .w_full()
            .gap_3()
            .px_4()
            .pb_2()
            .child(Input::new(&self.title).w_full())
            .child(Input::new(&self.notes).w_full())
            .child(
                h_flex()
                    .w_full()
                    .gap_2()
                    .items_end()
                    .child(field(
                        "项目",
                        muted,
                        project_menu(form.clone(), project_id, project_label),
                    ))
                    .child(field(
                        "状态",
                        muted,
                        status_menu(form.clone(), status, status_label),
                    ))
                    .child(field(
                        "标签",
                        muted,
                        tag_menu(form.clone(), tag_ids, tag_label),
                    )),
            )
            .child({
                let form = form.clone();
                v_flex()
                    .w_full()
                    .gap_1()
                    .when(!bound_tags.is_empty(), |col| {
                        let form = form.clone();
                        col.child(
                            h_flex().w_full().gap_1().flex_wrap().children(
                                bound_tags
                                    .into_iter()
                                    .map(|(id, title)| tag_chip(form.clone(), id, title, danger)),
                            ),
                        )
                    })
                    .child(
                        // 单行输入会把 Enter 冒泡成对话框的 Confirm。吃掉确认，窗口才不会被回车关掉。
                        div()
                            .id("task-tag-field")
                            .w_full()
                            .on_action(|_: &Confirm, _, cx| {
                                cx.stop_propagation();
                            })
                            .child(Input::new(&self.tag_input).w_full().small()),
                    )
            })
            .child(
                h_flex()
                    .w_full()
                    .gap_2()
                    .items_end()
                    .child(field(
                        "开始",
                        muted,
                        DatePicker::new(&self.start)
                            .small()
                            .w_full()
                            .cleanable(true)
                            .placeholder("选择开始时间"),
                    ))
                    .child(field(
                        "截止",
                        muted,
                        DatePicker::new(&self.deadline)
                            .small()
                            .w_full()
                            .cleanable(true)
                            .placeholder("选择截止时间"),
                    )),
            )
            .child(
                h_flex()
                    .w_full()
                    .gap_2()
                    .items_end()
                    .child(field(
                        "计划提醒",
                        muted,
                        remind_menu(form.clone(), "task-plan-remind", plan_remind, true),
                    ))
                    .child(field(
                        "截止提醒",
                        muted,
                        remind_menu(form.clone(), "task-deadline-remind", deadline_remind, false),
                    )),
            )
            .child(
                Button::new("task-repeat-toggle")
                    .small()
                    .ghost()
                    .label(repeat_label)
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_repeat(cx))),
            )
            .when(self.repeat_open, |col| {
                let form = form.clone();
                col.child(
                    h_flex().gap_1().flex_wrap().children(
                        [
                            (None, "无"),
                            (Some(TimedSchedulePreset::Daily), "每天"),
                            (Some(TimedSchedulePreset::Weekdays), "工作日"),
                            (Some(TimedSchedulePreset::Weekly), "每周"),
                            (Some(TimedSchedulePreset::Monthly), "每月"),
                        ]
                        .into_iter()
                        .map(|(preset, label)| {
                            let active = repeat == preset;
                            let form = form.clone();
                            Button::new(SharedString::from(format!("task-repeat-{label}")))
                                .xsmall()
                                .when(active, |button| button.primary())
                                .when(!active, |button| button.ghost())
                                .label(label)
                                .on_click(move |_, _, cx| {
                                    form.update(cx, |form, cx| form.set_repeat(preset, cx)).ok();
                                })
                        }),
                    ),
                )
            })
            .child(Input::new(&self.subtask).w_full())
            .when(!subtasks.is_empty(), |col| {
                col.child(v_flex().gap_1().children(subtasks.into_iter().map(|title| {
                    div()
                        .px_2()
                        .py_1()
                        .text_sm()
                        .rounded(radius)
                        .border_1()
                        .border_color(border)
                        .child(title)
                })))
            })
    }
}

impl TaskForm {
    fn subtask_rows(&self) -> Vec<String> {
        let mut rows = self.pending_subtasks.clone();
        if let Some(id) = &self.task_id {
            let mut saved = self.state.with(|s| {
                s.repo
                    .list_tasks()
                    .into_iter()
                    .filter(|task| task.parent_id.as_deref() == Some(id.as_str()))
                    .map(|task| task.title)
                    .collect::<Vec<_>>()
            });
            rows.append(&mut saved);
        }
        rows
    }
}

fn tag_chip(
    form: WeakEntity<TaskForm>,
    id: String,
    title: String,
    danger: Hsla,
) -> impl IntoElement {
    let tag_id = id.clone();
    Tag::secondary().xsmall().outline().child(
        h_flex()
            .items_center()
            .gap_1()
            .child(format!("#{title}"))
            .child(
                div()
                    .id(SharedString::from(format!("task-tag-x-{id}")))
                    .cursor_pointer()
                    .hover(move |style| style.text_color(danger))
                    .child(Icon::new(IconName::Close).xsmall())
                    .on_click(move |_, _, cx| {
                        cx.stop_propagation();
                        form.update(cx, |form, cx| form.remove_tag(&tag_id, cx))
                            .ok();
                    }),
            ),
    )
}

fn remind_option_of(due: Option<i64>, remind_at: Option<i64>) -> ReminderOptionId {
    match (due, remind_at) {
        (Some(due), Some(at)) => milliseconds_diff_to_remind_option(due.saturating_sub(at)),
        _ => ReminderOptionId::None,
    }
}

const REMIND_OPTIONS: [ReminderOptionId; 7] = [
    ReminderOptionId::None,
    ReminderOptionId::AtStart,
    ReminderOptionId::M5,
    ReminderOptionId::M10,
    ReminderOptionId::M15,
    ReminderOptionId::M30,
    ReminderOptionId::H1,
];

fn remind_menu(
    form: WeakEntity<TaskForm>,
    id: &'static str,
    current: ReminderOptionId,
    plan: bool,
) -> impl IntoElement {
    Button::new(id)
        .small()
        .outline()
        .w_full()
        .dropdown_caret(true)
        .label(remind_option_label(current))
        .dropdown_menu_with_anchor(Anchor::BottomLeft, move |menu, _, _| {
            REMIND_OPTIONS.into_iter().fold(menu, |menu, option| {
                let form = form.clone();
                menu.item(
                    PopupMenuItem::new(remind_option_label(option))
                        .checked(option == current)
                        .on_click(move |_, _, cx| {
                            form.update(cx, |form, cx| {
                                if plan {
                                    form.set_plan_remind(option, cx);
                                } else {
                                    form.set_deadline_remind(option, cx);
                                }
                            })
                            .ok();
                        }),
                )
            })
        })
}

fn field(label: &'static str, muted: Hsla, control: impl IntoElement) -> impl IntoElement {
    v_flex()
        .flex_1()
        .min_w_0()
        .gap_1()
        .child(div().text_xs().text_color(muted).child(label))
        .child(control)
}

fn project_menu(form: WeakEntity<TaskForm>, current: String, label: String) -> impl IntoElement {
    let menu_form = form.clone();
    Button::new("task-project")
        .small()
        .outline()
        .w_full()
        .dropdown_caret(true)
        .label(label)
        .dropdown_menu_with_anchor(Anchor::BottomLeft, move |menu, _, cx| {
            let Some(form) = menu_form.upgrade() else {
                return menu;
            };
            let projects = form.read(cx).state.with(|s| {
                s.repo
                    .list_projects()
                    .into_iter()
                    .filter(|project| !project.is_archived || project.id == INBOX_PROJECT_ID)
                    .map(|project| (project.id, project.title))
                    .collect::<Vec<_>>()
            });
            projects.into_iter().fold(menu, |menu, (id, title)| {
                let form = menu_form.clone();
                let picked = id.clone();
                menu.item(PopupMenuItem::new(title).checked(id == current).on_click(
                    move |_, _, cx| {
                        form.update(cx, |form, cx| form.set_project(picked.clone(), cx))
                            .ok();
                    },
                ))
            })
        })
}

fn status_menu(
    form: WeakEntity<TaskForm>,
    current: TaskStatus,
    label: &'static str,
) -> impl IntoElement {
    Button::new("task-status")
        .small()
        .outline()
        .w_full()
        .dropdown_caret(true)
        .label(label)
        .dropdown_menu_with_anchor(Anchor::BottomLeft, move |menu, _, _| {
            [TaskStatus::Todo, TaskStatus::Doing, TaskStatus::Done]
                .into_iter()
                .fold(menu, |menu, status| {
                    let form = form.clone();
                    menu.item(
                        PopupMenuItem::new(status.label())
                            .checked(status == current)
                            .on_click(move |_, window, cx| {
                                form.update(cx, |form, cx| form.set_status(status, window, cx))
                                    .ok();
                            }),
                    )
                })
        })
}

fn tag_menu(form: WeakEntity<TaskForm>, selected: Vec<String>, label: String) -> impl IntoElement {
    let menu_form = form.clone();
    Button::new("task-tags")
        .small()
        .outline()
        .w_full()
        .dropdown_caret(true)
        .label(label)
        .dropdown_menu_with_anchor(Anchor::BottomLeft, move |menu, _, cx| {
            let Some(form) = menu_form.upgrade() else {
                return menu;
            };
            let tags = form.read(cx).state.with(|s| {
                s.repo
                    .list_tags()
                    .into_iter()
                    .map(|tag| (tag.id, tag.title))
                    .collect::<Vec<_>>()
            });
            if tags.is_empty() {
                return menu.item(PopupMenuItem::new("还没有标签").disabled(true));
            }
            tags.into_iter().fold(menu, |menu, (id, title)| {
                let form = menu_form.clone();
                let picked = id.clone();
                menu.item(
                    PopupMenuItem::new(format!("#{title}"))
                        .checked(selected.iter().any(|tag_id| tag_id == &id))
                        .on_click(move |_, _, cx| {
                            form.update(cx, |form, cx| form.toggle_tag(&picked, cx))
                                .ok();
                        }),
                )
            })
        })
}

fn picker_ms(picker: &Entity<DatePickerState>, cx: &App) -> Option<i64> {
    match picker.read(cx).date_time() {
        DateTime::Single(Some(when)) => civil_to_ms(when),
        _ => None,
    }
}

fn write_picker(
    picker: &Entity<DatePickerState>,
    ms: Option<i64>,
    window: &mut Window,
    cx: &mut Context<TaskForm>,
) {
    picker.update(cx, |state, cx| {
        if let Some(when) = ms.and_then(ms_to_civil) {
            state.set_date_time(when, window, cx);
        } else {
            state.set_date(Date::Single(None), window, cx);
        }
    });
}

fn ms_to_civil(ms: i64) -> Option<jiff::civil::DateTime> {
    let zoned = jiff::Timestamp::from_millisecond(ms)
        .ok()?
        .to_zoned_datetime(jiff::tz::TimeZone::system());
    Some(zoned.datetime())
}

fn civil_to_ms(when: jiff::civil::DateTime) -> Option<i64> {
    when.to_zoned_datetime(jiff::tz::TimeZone::system())
        .ok()
        .map(|zoned| zoned.timestamp().as_millisecond())
}

fn format_cn(ms: i64) -> String {
    use chrono::{Datelike as _, TimeZone as _, Timelike as _};
    let dt = chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(chrono::Local::now);
    format!(
        "{}月{}日 {:02}:{:02}",
        dt.month(),
        dt.day(),
        dt.hour(),
        dt.minute()
    )
}
