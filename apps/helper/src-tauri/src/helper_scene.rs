use std::time::Instant;

use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    marks: Vec<Value>,
    presence: Vec<Value>,
    sharer_id: String,
    pub paused: bool,
    pub fence: u64,
    pub can_draw: bool,
    server_at_ms: u64,
    #[serde(skip)]
    revision: u64,
    #[serde(skip)]
    pub observed_at: Instant,
}

impl Scene {
    pub fn snapshot(frame: &Value, layer: &str, publication: &str, sharer: &str) -> Option<Self> {
        let state = &frame["state"];
        let binding = &state["layer"];
        let marks = state["marks"].as_array()?;
        if binding["layer_id"].as_str()? != layer
            || binding["publication_id"].as_str()? != publication
            || binding["sharer_id"].as_str()? != sharer
            || marks.len() > 512
        {
            return None;
        }
        Some(Self {
            marks: marks.clone(),
            presence: Vec::new(),
            sharer_id: sharer.to_owned(),
            paused: state["paused"].as_bool()?,
            fence: state["fence"].as_u64()?,
            can_draw: state["access"]["can_draw"].as_bool()?,
            revision: state["revision"].as_u64()?,
            server_at_ms: frame["server_at_ms"].as_u64()?,
            observed_at: Instant::now(),
        })
    }

    pub fn refresh(&mut self, mut snapshot: Self) {
        if snapshot.fence == self.fence && !snapshot.paused {
            self.presence.retain(|sample| {
                sample["expires_at_ms"]
                    .as_u64()
                    .is_some_and(|until| until > snapshot.server_at_ms)
            });
            snapshot.presence = std::mem::take(&mut self.presence);
        }
        *self = snapshot;
    }

    pub fn apply(&mut self, frame: &Value) -> Option<()> {
        let revision = frame["revision"].as_u64()?;
        if revision <= self.revision {
            return Some(());
        }
        if self.revision.checked_add(1) != Some(revision) {
            return None;
        }
        let fence = frame["fence"].as_u64()?;
        let now = frame["server_at_ms"].as_u64()?;
        let change = &frame["change"];
        match change["kind"].as_str()? {
            "upsert" => {
                let mark = &change["mark"];
                let id = mark["draft"]["mark_id"].as_str()?;
                self.marks
                    .retain(|existing| existing["draft"]["mark_id"] != id);
                if self.marks.len() >= 512 {
                    return None;
                }
                self.marks.push(mark.clone());
            }
            "remove" => {
                let id = change["mark_id"].as_str()?;
                self.marks.retain(|mark| mark["draft"]["mark_id"] != id);
            }
            "clear" => {
                let participant = change["participant_id"].as_str();
                self.marks.retain(|mark| {
                    participant.is_some_and(|id| mark["author"]["participant_id"] != id)
                });
            }
            "control" => {
                self.paused = change["paused"].as_bool()?;
                self.can_draw = change["access"]["can_draw"].as_bool()?;
            }
            _ => return None,
        }
        if self.fence != fence || self.paused {
            self.presence.clear();
        }
        self.fence = fence;
        self.revision = revision;
        self.server_at_ms = now;
        self.observed_at = Instant::now();
        Some(())
    }

    pub fn presence(&mut self, frame: Value) {
        if self.paused || frame["fence"].as_u64() != Some(self.fence) {
            return;
        }
        let Some(id) = frame["author"]["participant_id"].as_str() else {
            return;
        };
        self.presence
            .retain(|sample| sample["author"]["participant_id"] != id);
        if self.presence.len() < 128 && (!frame["cursor"].is_null() || !frame["draft"].is_null()) {
            self.presence.push(frame);
        }
    }

    pub fn render_now(&mut self) {
        self.server_at_ms = self
            .server_at_ms
            .saturating_add(self.observed_at.elapsed().as_millis() as u64);
    }
}

pub fn request() -> Value {
    json!({"type": "annotation_state_request"})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_matching_sync_state_and_does_not_skip_a_missing_revision() {
        let snapshot = json!({
            "type": "annotation_state",
            "server_at_ms": 100,
            "state": {
                "layer": {"layer_id": "layer", "publication_id": "publication", "sharer_id": "sharer"},
                "paused": false,
                "fence": 4,
                "revision": 2,
                "access": {"can_draw": true},
                "marks": [],
            }
        });
        assert!(Scene::snapshot(&snapshot, "layer", "other", "sharer").is_none());
        assert!(Scene::snapshot(&snapshot, "layer", "publication", "other").is_none());
        let mut scene = Scene::snapshot(&snapshot, "layer", "publication", "sharer").unwrap();
        let mut change = json!({
            "type": "annotation_changed",
            "server_at_ms": 120,
            "revision": 4,
            "fence": 4,
            "change": {"kind": "upsert", "mark": {"draft": {"mark_id": "mark"}}},
        });
        assert!(scene.apply(&change).is_none());
        assert!(scene.marks.is_empty());
        change["revision"] = json!(3);
        assert!(scene.apply(&change).is_some());
        assert_eq!(scene.marks.len(), 1);
    }
}
