use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn right(self) -> i32 {
        self.x + self.width as i32
    }

    fn bottom(self) -> i32 {
        self.y + self.height as i32
    }

    pub fn intersect(self, other: Self) -> Option<Self> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        if x >= right || y >= bottom {
            return None;
        }
        Some(Self {
            x,
            y,
            width: (right - x) as u32,
            height: (bottom - y) as u32,
        })
    }

    pub fn contains(self, point: Point) -> bool {
        point.x >= f64::from(self.x)
            && point.x < f64::from(self.right())
            && point.y >= f64::from(self.y)
            && point.y < f64::from(self.bottom())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Segment {
    pub bounds: Rect,
    frame: Rect,
}

impl Segment {
    pub fn new(frame: Rect, monitor: Rect) -> Option<Self> {
        Some(Self {
            bounds: frame.intersect(monitor)?,
            frame,
        })
    }

    pub fn frame_point(self, local: Point) -> Option<Point> {
        let desktop = Point {
            x: local.x + f64::from(self.bounds.x),
            y: local.y + f64::from(self.bounds.y),
        };
        self.bounds.contains(desktop).then(|| Point {
            x: (desktop.x - f64::from(self.frame.x)) / f64::from(self.frame.width),
            y: (desktop.y - f64::from(self.frame.y)) / f64::from(self.frame.height),
        })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    #[default]
    Top,
    Right,
    Bottom,
    Left,
}

impl Edge {
    pub fn vertical(self) -> bool {
        matches!(self, Self::Left | Self::Right)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Dock {
    pub edge: Edge,
    pub offset: f64,
}

impl Default for Dock {
    fn default() -> Self {
        Self {
            edge: Edge::Top,
            offset: 0.5,
        }
    }
}

impl Dock {
    pub fn snap(monitor: Rect, point: Point) -> Self {
        let x = (point.x - f64::from(monitor.x)).clamp(0.0, f64::from(monitor.width));
        let y = (point.y - f64::from(monitor.y)).clamp(0.0, f64::from(monitor.height));
        let distances = [
            (Edge::Top, y),
            (Edge::Right, f64::from(monitor.width) - x),
            (Edge::Bottom, f64::from(monitor.height) - y),
            (Edge::Left, x),
        ];
        let edge = distances
            .into_iter()
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .expect("four screen edges")
            .0;
        let offset = if edge.vertical() {
            y / f64::from(monitor.height.max(1))
        } else {
            x / f64::from(monitor.width.max(1))
        };
        Self { edge, offset }
    }

    pub fn position(self, monitor: Rect, width: u32, height: u32) -> (i32, i32) {
        let x_margin = monitor.width.saturating_sub(width) as i32;
        let y_margin = monitor.height.saturating_sub(height) as i32;
        let x = (self.offset * f64::from(monitor.width) - f64::from(width) / 2.0)
            .round()
            .clamp(0.0, f64::from(x_margin)) as i32;
        let y = (self.offset * f64::from(monitor.height) - f64::from(height) / 2.0)
            .round()
            .clamp(0.0, f64::from(y_margin)) as i32;
        match self.edge {
            Edge::Top => (monitor.x + x, monitor.y),
            Edge::Right => (monitor.x + x_margin, monitor.y + y),
            Edge::Bottom => (monitor.x + x, monitor.y + y_margin),
            Edge::Left => (monitor.x, monitor.y + y),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitor_segments_map_to_the_same_frame_across_negative_origin() {
        let frame = Rect {
            x: -400,
            y: 100,
            width: 800,
            height: 600,
        };
        let left = Rect {
            x: -1600,
            y: -200,
            width: 1600,
            height: 1000,
        };
        let right = Rect {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
        };
        let left = Segment::new(frame, left).unwrap();
        let right = Segment::new(frame, right).unwrap();
        assert_eq!(left.bounds.width, 400);
        assert_eq!(right.bounds.width, 400);
        assert_eq!(
            left.frame_point(Point { x: 200.0, y: 300.0 }),
            Some(Point { x: 0.25, y: 0.5 })
        );
        assert_eq!(
            right.frame_point(Point { x: 0.0, y: 300.0 }),
            Some(Point { x: 0.5, y: 0.5 })
        );
        assert_eq!(left.frame_point(Point { x: 400.0, y: 300.0 }), None);
    }

    #[test]
    fn nearest_edge_clamps_the_whole_control_to_the_work_area() {
        let monitor = Rect {
            x: -960,
            y: 100,
            width: 960,
            height: 680,
        };
        for (point, edge) in [
            (
                Point {
                    x: -480.0,
                    y: 103.0,
                },
                Edge::Top,
            ),
            (Point { x: -2.0, y: 300.0 }, Edge::Right),
            (
                Point {
                    x: -480.0,
                    y: 778.0,
                },
                Edge::Bottom,
            ),
            (
                Point {
                    x: -959.0,
                    y: 685.0,
                },
                Edge::Left,
            ),
        ] {
            let dock = Dock::snap(monitor, point);
            assert_eq!(dock.edge, edge);
            let (x, y) = dock.position(monitor, 140, 90);
            let control = Rect {
                x,
                y,
                width: 140,
                height: 90,
            };
            assert_eq!(monitor.intersect(control), Some(control));
        }
        assert_eq!(Dock::default().position(monitor, 200, 40), (-580, 100));
    }
}
