//! Agent 右侧栏可视化：蜂群三维、依赖图画布、核图谱。
//!
//! 数据来自当前工作区的会话、Cargo 包和 Markdown 双链，画布交互对齐 Hadron 的三种模式。

use gpui_kit::*;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::f32::consts::PI;
use std::path::Path;
use std::rc::Rc;
use wb_domain::extract_wikilinks;

pub type VizHits = Rc<RefCell<Vec<(String, f32, f32, f32)>>>;

#[derive(Clone, Debug)]
pub struct VizNode {
    pub id: String,
    pub label: String,
    pub detail: String,
    pub hot: bool,
}

#[derive(Clone, Debug)]
pub struct VizEdge {
    pub from: String,
    pub to: String,
    pub broken: bool,
}

#[derive(Clone, Debug, Default)]
pub struct VizGraph {
    pub nodes: Vec<VizNode>,
    pub edges: Vec<VizEdge>,
}

#[derive(Clone, Copy)]
struct Point3 {
    x: f32,
    y: f32,
    z: f32,
}

impl Point3 {
    fn from_spherical(radius: f32, theta: f32, phi: f32) -> Self {
        let cos_theta = theta.cos();
        Self {
            x: radius * cos_theta * phi.cos(),
            y: radius * theta.sin(),
            z: radius * cos_theta * phi.sin(),
        }
    }

    fn rotate(self, yaw: f32, pitch: f32) -> Self {
        let (cy, sy) = (yaw.cos(), yaw.sin());
        let x1 = self.x * cy + self.z * sy;
        let z1 = -self.x * sy + self.z * cy;
        let (cp, sp) = (pitch.cos(), pitch.sin());
        Self {
            x: x1,
            y: self.y * cp - z1 * sp,
            z: self.y * sp + z1 * cp,
        }
    }

    fn project(self, cx: f32, cy: f32, distance: f32) -> (f32, f32, f32) {
        let scale = (distance / (distance + 220.0 - self.z)).clamp(0.35, 2.5);
        (cx + self.x * scale, cy - self.y * scale, scale)
    }
}

pub fn swarm_nodes(threads: &[(String, String, bool)], active: Option<&str>) -> VizGraph {
    let mut nodes = Vec::new();
    if let Some(id) = active {
        let label = threads
            .iter()
            .find(|(tid, _, _)| tid == id)
            .map(|(_, title, _)| title.clone())
            .unwrap_or_else(|| "当前会话".into());
        nodes.push(VizNode {
            id: id.to_string(),
            label,
            detail: "编排中心".into(),
            hot: true,
        });
    }
    for (id, title, busy) in threads {
        if Some(id.as_str()) == active {
            continue;
        }
        nodes.push(VizNode {
            id: id.clone(),
            label: title.clone(),
            detail: if *busy { "进行中" } else { "待命" }.into(),
            hot: *busy,
        });
    }
    if nodes.is_empty() {
        nodes.push(VizNode {
            id: "empty".into(),
            label: "还没有会话".into(),
            detail: "打开一个会话后会出现在球面上".into(),
            hot: false,
        });
    }
    let hub = nodes.first().map(|node| node.id.clone());
    let edges = hub
        .into_iter()
        .flat_map(|from| {
            nodes.iter().skip(1).map(move |node| VizEdge {
                from: from.clone(),
                to: node.id.clone(),
                broken: false,
            })
        })
        .collect();
    VizGraph { nodes, edges }
}

pub fn dependency_graph(root: &Path) -> VizGraph {
    let manifests = cargo_manifests(root);
    if manifests.is_empty() {
        return directory_graph(root);
    }
    let mut names = Vec::new();
    let mut deps: HashMap<String, Vec<String>> = HashMap::new();
    for path in &manifests {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let Some(name) = cargo_package_name(&text) else {
            continue;
        };
        let depends = cargo_dep_names(&text);
        names.push(name.clone());
        deps.insert(name, depends);
    }
    let known: HashSet<_> = names.iter().cloned().collect();
    let mut edges = Vec::new();
    for (name, depends) in &deps {
        for dep in depends {
            if known.contains(dep) && dep != name {
                edges.push(VizEdge {
                    from: name.clone(),
                    to: dep.clone(),
                    broken: false,
                });
            }
        }
    }
    let changed = changed_prefixes(root);
    let nodes = names
        .into_iter()
        .map(|name| VizNode {
            id: name.clone(),
            label: name.clone(),
            detail: format!("{} 个依赖", deps.get(&name).map(|d| d.len()).unwrap_or(0)),
            hot: changed.iter().any(|prefix| prefix.contains(&name)),
        })
        .collect();
    VizGraph { nodes, edges }
}

pub fn nucleus_graph(root: &Path) -> VizGraph {
    let notes = markdown_notes(root);
    let titles: HashSet<String> = notes.iter().map(|(title, _)| title.clone()).collect();
    let mut edges = Vec::new();
    let mut linked = HashSet::new();
    for (title, body) in &notes {
        for target in extract_wikilinks(body) {
            let key = target.trim_end_matches(".md").to_string();
            let broken = !titles.iter().any(|name| name.eq_ignore_ascii_case(&key));
            if !broken {
                linked.insert(title.clone());
                linked.insert(key.clone());
            }
            edges.push(VizEdge {
                from: title.clone(),
                to: key,
                broken,
            });
        }
    }
    let nodes = notes
        .into_iter()
        .map(|(title, _)| VizNode {
            id: title.clone(),
            label: title.clone(),
            detail: if linked.contains(&title) {
                "已连接".into()
            } else {
                "孤立".into()
            },
            hot: !linked.contains(&title),
        })
        .collect();
    VizGraph { nodes, edges }
}

pub fn paint_swarm(
    graph: &VizGraph,
    yaw: f32,
    pitch: f32,
    focus: Option<&str>,
    hits: &VizHits,
    accent: Hsla,
    muted: Hsla,
) -> impl IntoElement {
    let nodes = graph.nodes.clone();
    let edges = graph.edges.clone();
    let hits = hits.clone();
    let focus = focus.map(str::to_string);
    canvas(
        |bounds, _, _| bounds,
        move |bounds, _, window, _| {
            let width = f32::from(bounds.size.width);
            let height = f32::from(bounds.size.height);
            let origin_x = f32::from(bounds.origin.x);
            let origin_y = f32::from(bounds.origin.y);
            let cx = origin_x + width / 2.0;
            let cy = origin_y + height / 2.0;
            let radius = (width.min(height) * 0.32).clamp(70.0, 180.0);
            let mut placed = Vec::new();
            let count = nodes.len().max(1) as f32;
            for (index, node) in nodes.iter().enumerate() {
                let point = if index == 0 {
                    Point3 {
                        x: 0.0,
                        y: 0.0,
                        z: radius * 0.15,
                    }
                } else {
                    let phi = (index as f32) * 2.399963;
                    let theta = ((index as f32 / count) * 2.0 - 1.0).asin();
                    Point3::from_spherical(radius, theta, phi).rotate(yaw, pitch)
                };
                let (x, y, scale) = point.project(cx, cy, 420.0);
                placed.push((node, x, y, scale, point.z));
            }
            placed.sort_by(|a, b| a.4.partial_cmp(&b.4).unwrap_or(std::cmp::Ordering::Equal));
            let index_of = |id: &str| nodes.iter().position(|node| node.id == id);
            for edge in &edges {
                let (Some(from), Some(to)) = (index_of(&edge.from), index_of(&edge.to)) else {
                    continue;
                };
                if let (Some(a), Some(b)) = (
                    placed.iter().find(|(node, ..)| node.id == nodes[from].id),
                    placed.iter().find(|(node, ..)| node.id == nodes[to].id),
                ) {
                    paint_segment(window, a.1, a.2, b.1, b.2, accent.opacity(0.45));
                }
            }
            let mut next_hits = Vec::new();
            for (node, x, y, scale, _) in &placed {
                let r = 7.0 * scale;
                let selected = focus.as_deref() == Some(node.id.as_str());
                let color = if node.hot || selected { accent } else { muted };
                let bounds = Bounds {
                    origin: point(px(x - r), px(y - r)),
                    size: size(px(r * 2.0), px(r * 2.0)),
                };
                window.paint_quad(fill(bounds, color).corner_radii(px(r)));
                next_hits.push((node.id.clone(), *x, *y, r + 6.0));
            }
            *hits.borrow_mut() = next_hits;
        },
    )
    .size_full()
}

pub fn paint_flat(
    graph: &VizGraph,
    zoom: f32,
    focus: Option<&str>,
    hits: &VizHits,
    accent: Hsla,
    muted: Hsla,
    layered: bool,
) -> impl IntoElement {
    let nodes = graph.nodes.clone();
    let edges = graph.edges.clone();
    let hits = hits.clone();
    let focus = focus.map(str::to_string);
    canvas(
        |bounds, _, _| bounds,
        move |bounds, _, window, _| {
            let width = f32::from(bounds.size.width);
            let height = f32::from(bounds.size.height);
            let origin_x = f32::from(bounds.origin.x);
            let origin_y = f32::from(bounds.origin.y);
            let positions = if layered {
                layer_positions(&nodes, &edges, width, height, zoom)
            } else {
                circle_positions(&nodes, width, height, zoom)
            };
            for edge in &edges {
                let (Some(a), Some(b)) = (positions.get(&edge.from), positions.get(&edge.to))
                else {
                    continue;
                };
                let color = if edge.broken {
                    muted.opacity(0.35)
                } else {
                    accent.opacity(0.55)
                };
                paint_segment(
                    window,
                    origin_x + a.0,
                    origin_y + a.1,
                    origin_x + b.0,
                    origin_y + b.1,
                    color,
                );
            }
            let mut next_hits = Vec::new();
            for node in &nodes {
                let Some((x, y)) = positions.get(&node.id) else {
                    continue;
                };
                let selected = focus.as_deref() == Some(node.id.as_str());
                let color = if selected {
                    accent
                } else if node.hot {
                    accent.opacity(0.75)
                } else {
                    muted
                };
                let r = if layered { 8.0 } else { 6.0 };
                let bounds = Bounds {
                    origin: point(px(origin_x + x - r), px(origin_y + y - r)),
                    size: size(px(r * 2.0), px(r * 2.0)),
                };
                window.paint_quad(fill(bounds, color).corner_radii(px(r)));
                next_hits.push((node.id.clone(), origin_x + x, origin_y + y, r + 8.0));
            }
            *hits.borrow_mut() = next_hits;
        },
    )
    .size_full()
}

fn paint_segment(window: &mut Window, x0: f32, y0: f32, x1: f32, y1: f32, color: Hsla) {
    let steps = 12;
    for step in 0..=steps {
        let t = step as f32 / steps as f32;
        let x = x0 + (x1 - x0) * t;
        let y = y0 + (y1 - y0) * t;
        let bounds = Bounds {
            origin: point(px(x - 1.0), px(y - 1.0)),
            size: size(px(2.0), px(2.0)),
        };
        window.paint_quad(fill(bounds, color));
    }
}

fn circle_positions(
    nodes: &[VizNode],
    width: f32,
    height: f32,
    zoom: f32,
) -> HashMap<String, (f32, f32)> {
    let mut out = HashMap::new();
    let count = nodes.len().max(1) as f32;
    let radius = (width.min(height) * 0.32 * zoom).clamp(40.0, 220.0);
    for (index, node) in nodes.iter().enumerate() {
        let angle = (index as f32) / count * PI * 2.0 - PI / 2.0;
        out.insert(
            node.id.clone(),
            (
                width / 2.0 + angle.cos() * radius,
                height / 2.0 + angle.sin() * radius,
            ),
        );
    }
    out
}

fn layer_positions(
    nodes: &[VizNode],
    edges: &[VizEdge],
    width: f32,
    height: f32,
    zoom: f32,
) -> HashMap<String, (f32, f32)> {
    let mut depth: HashMap<&str, usize> = HashMap::new();
    for _ in 0..nodes.len() {
        for edge in edges {
            let from = depth.get(edge.from.as_str()).copied().unwrap_or(0);
            let next = from + 1;
            let slot = depth.entry(edge.to.as_str()).or_insert(0);
            if next > *slot && next < 8 {
                *slot = next;
            }
        }
    }
    let mut columns: HashMap<usize, Vec<&VizNode>> = HashMap::new();
    for node in nodes {
        let column = depth.get(node.id.as_str()).copied().unwrap_or(0);
        columns.entry(column).or_default().push(node);
    }
    let column_count = columns.len().max(1) as f32;
    let mut out = HashMap::new();
    for (column, group) in columns {
        let row_count = group.len().max(1) as f32;
        for (row, node) in group.iter().enumerate() {
            let x = width * (0.15 + 0.7 * ((column as f32 + 0.5) / column_count)) * zoom.min(1.4);
            let y = height * (0.12 + 0.76 * ((row as f32 + 0.5) / row_count));
            out.insert(node.id.clone(), (x.clamp(16.0, width - 16.0), y));
        }
    }
    out
}

fn cargo_manifests(root: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let root_manifest = root.join("Cargo.toml");
    if root_manifest.is_file() {
        out.push(root_manifest);
    }
    let Ok(read) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in read.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if path.is_dir() {
            let manifest = path.join("Cargo.toml");
            if manifest.is_file() {
                out.push(manifest);
            }
            let nested = path.join("crates");
            if nested.is_dir() {
                if let Ok(crates) = std::fs::read_dir(&nested) {
                    for crate_dir in crates.filter_map(|entry| entry.ok()) {
                        let manifest = crate_dir.path().join("Cargo.toml");
                        if manifest.is_file() {
                            out.push(manifest);
                        }
                    }
                }
            }
        }
    }
    out.truncate(48);
    out
}

fn cargo_package_name(text: &str) -> Option<String> {
    let mut in_package = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_package = trimmed == "[package]";
        } else if in_package && let Some(rest) = trimmed.strip_prefix("name") {
            let value = rest.trim().trim_start_matches('=').trim().trim_matches('"');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn cargo_dep_names(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut in_deps = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_deps = trimmed == "[dependencies]" || trimmed == "[dev-dependencies]";
            continue;
        }
        if !in_deps || trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let name = trimmed.split(['=', '.']).next().unwrap_or("").trim();
        if !name.is_empty() && !name.contains(' ') {
            names.push(name.to_string());
        }
    }
    names
}

fn changed_prefixes(root: &Path) -> Vec<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["diff", "--name-only", "HEAD"])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

fn directory_graph(root: &Path) -> VizGraph {
    let Ok(read) = std::fs::read_dir(root) else {
        return VizGraph::default();
    };
    let mut nodes = Vec::new();
    for entry in read.filter_map(|entry| entry.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        nodes.push(VizNode {
            id: name.clone(),
            label: name,
            detail: if entry.path().is_dir() {
                "目录"
            } else {
                "文件"
            }
            .into(),
            hot: false,
        });
        if nodes.len() == 24 {
            break;
        }
    }
    VizGraph {
        nodes,
        edges: Vec::new(),
    }
}

fn markdown_notes(root: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    fn walk(dir: &Path, depth: usize, out: &mut Vec<(String, String)>) {
        if depth > 2 || out.len() >= 36 {
            return;
        }
        let Ok(read) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in read.filter_map(|entry| entry.ok()) {
            if out.len() >= 36 {
                return;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "target" || name == "node_modules" {
                continue;
            }
            if path.is_dir() {
                walk(&path, depth + 1, out);
            } else if name.ends_with(".md") {
                let title = name.trim_end_matches(".md").to_string();
                let body = std::fs::read_to_string(&path).unwrap_or_default();
                out.push((title, body.chars().take(4000).collect()));
            }
        }
    }
    walk(root, 0, &mut out);
    out
}
