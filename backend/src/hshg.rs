use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct HshgEntry {
    pub id: String,
    pub center: [f32; 3],
    pub radius: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct HshgCellKey {
    level: u8,
    x: i32,
    y: i32,
    z: i32,
}

#[derive(Debug, Clone)]
struct IndexedEntry {
    center: [f32; 3],
    level: u8,
}

#[derive(Debug, Clone)]
pub struct HierarchicalSpatialHashGrid {
    base_cell_edge: f32,
    max_levels: u8,
    buckets: HashMap<HshgCellKey, HashSet<String>>,
    entries_by_id: HashMap<String, IndexedEntry>,
}

impl HierarchicalSpatialHashGrid {
    pub fn new(base_cell_edge: f32, max_levels: u8) -> Self {
        let sanitized_cell_edge = if base_cell_edge.is_finite() && base_cell_edge > 0.0 {
            base_cell_edge
        } else {
            1.0
        };
        let sanitized_levels = max_levels.max(1);

        Self {
            base_cell_edge: sanitized_cell_edge,
            max_levels: sanitized_levels,
            buckets: HashMap::new(),
            entries_by_id: HashMap::new(),
        }
    }

    pub fn clear(&mut self) {
        self.buckets.clear();
        self.entries_by_id.clear();
    }

    pub fn insert(&mut self, entry: HshgEntry) {
        let id = entry.id.trim().to_string();
        if id.is_empty() {
            return;
        }
        if !entry.center.iter().all(|value| value.is_finite()) {
            return;
        }

        let level = self.level_for_radius(entry.radius);
        let cell = self.cell_key_for_position(entry.center, level);
        let indexed = IndexedEntry {
            center: entry.center,
            level,
        };
        self.entries_by_id.insert(id.clone(), indexed);
        self.buckets.entry(cell).or_default().insert(id);
    }

    pub fn rebuild(&mut self, entries: impl IntoIterator<Item = HshgEntry>) {
        self.clear();
        for entry in entries {
            self.insert(entry);
        }
    }

    pub fn query_radius(&self, center: [f32; 3], radius: f32, max_results: usize) -> Vec<String> {
        if max_results == 0 || !center.iter().all(|value| value.is_finite()) {
            return Vec::new();
        }

        let sanitized_radius = if radius.is_finite() && radius > 0.0 {
            radius
        } else {
            0.0
        };
        let radius_sq = sanitized_radius * sanitized_radius;
        let mut candidate_ids = HashSet::<String>::new();

        for level in 0..self.max_levels {
            let cell_edge = self.cell_edge_for_level(level);
            let min = [
                center[0] - sanitized_radius,
                center[1] - sanitized_radius,
                center[2] - sanitized_radius,
            ];
            let max = [
                center[0] + sanitized_radius,
                center[1] + sanitized_radius,
                center[2] + sanitized_radius,
            ];
            let min_key = self.cell_key_for_position(min, level);
            let max_key = self.cell_key_for_position(max, level);

            for x in min_key.x..=max_key.x {
                for y in min_key.y..=max_key.y {
                    for z in min_key.z..=max_key.z {
                        let key = HshgCellKey { level, x, y, z };
                        let Some(bucket) = self.buckets.get(&key) else {
                            continue;
                        };
                        for entry_id in bucket {
                            candidate_ids.insert(entry_id.clone());
                        }
                    }
                }
            }

            // Keep iteration deterministic regardless of level cell size.
            if cell_edge <= 0.0 {
                break;
            }
        }

        let mut matches = candidate_ids
            .into_iter()
            .filter_map(|entry_id| {
                let indexed = self.entries_by_id.get(entry_id.as_str())?;
                // Ensure stale bucket references do not leak when internals evolve.
                if indexed.level >= self.max_levels {
                    return None;
                }
                let dist_sq = distance_squared(center, indexed.center);
                if dist_sq > radius_sq {
                    return None;
                }
                Some((entry_id, dist_sq))
            })
            .collect::<Vec<_>>();

        matches.sort_by(|left, right| {
            left.1
                .total_cmp(&right.1)
                .then_with(|| left.0.cmp(&right.0))
        });
        matches.truncate(max_results);
        matches.into_iter().map(|(entry_id, _)| entry_id).collect()
    }

    fn level_for_radius(&self, radius: f32) -> u8 {
        let sanitized_radius = if radius.is_finite() && radius > 0.0 {
            radius
        } else {
            0.0
        };
        let diameter = (sanitized_radius * 2.0).max(0.001);
        let ratio = diameter / self.base_cell_edge;
        if ratio <= 1.0 {
            return 0;
        }

        let unclamped = ratio.log2().ceil();
        let max_level = (self.max_levels - 1) as f32;
        unclamped.clamp(0.0, max_level) as u8
    }

    fn cell_edge_for_level(&self, level: u8) -> f32 {
        self.base_cell_edge * 2f32.powi(level as i32)
    }

    fn cell_key_for_position(&self, position: [f32; 3], level: u8) -> HshgCellKey {
        let edge = self.cell_edge_for_level(level);
        HshgCellKey {
            level,
            x: quantize_axis(position[0], edge),
            y: quantize_axis(position[1], edge),
            z: quantize_axis(position[2], edge),
        }
    }
}

fn quantize_axis(value: f32, edge: f32) -> i32 {
    if !value.is_finite() || !edge.is_finite() || edge <= 0.0 {
        return 0;
    }

    let floored = (value / edge).floor();
    if floored <= i32::MIN as f32 {
        i32::MIN
    } else if floored >= i32::MAX as f32 {
        i32::MAX
    } else {
        floored as i32
    }
}

fn distance_squared(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let dz = b[2] - a[2];
    dx * dx + dy * dy + dz * dz
}

#[cfg(test)]
mod tests {
    use super::{HierarchicalSpatialHashGrid, HshgEntry};

    #[test]
    fn query_radius_returns_distance_sorted_ids() {
        let mut index = HierarchicalSpatialHashGrid::new(4.0, 6);
        index.rebuild(vec![
            HshgEntry {
                id: "b".to_string(),
                center: [2.0, 0.0, 0.0],
                radius: 0.4,
            },
            HshgEntry {
                id: "a".to_string(),
                center: [1.0, 0.0, 0.0],
                radius: 0.4,
            },
            HshgEntry {
                id: "c".to_string(),
                center: [5.0, 0.0, 0.0],
                radius: 0.4,
            },
        ]);

        let ids = index.query_radius([0.0, 0.0, 0.0], 8.0, 8);
        assert_eq!(ids, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn query_radius_supports_multiple_levels() {
        let mut index = HierarchicalSpatialHashGrid::new(2.0, 6);
        index.rebuild(vec![
            HshgEntry {
                id: "small-near".to_string(),
                center: [1.0, 0.0, 0.0],
                radius: 0.2,
            },
            HshgEntry {
                id: "large-near".to_string(),
                center: [3.0, 0.0, 0.0],
                radius: 6.0,
            },
            HshgEntry {
                id: "far".to_string(),
                center: [40.0, 0.0, 0.0],
                radius: 0.5,
            },
        ]);

        let ids = index.query_radius([0.0, 0.0, 0.0], 12.0, 10);
        assert_eq!(
            ids,
            vec!["small-near".to_string(), "large-near".to_string()]
        );
    }

    #[test]
    fn query_radius_is_deterministic_across_calls() {
        let mut index = HierarchicalSpatialHashGrid::new(3.0, 5);
        index.rebuild(vec![
            HshgEntry {
                id: "gamma".to_string(),
                center: [2.0, 2.0, 0.0],
                radius: 0.2,
            },
            HshgEntry {
                id: "alpha".to_string(),
                center: [2.0, -2.0, 0.0],
                radius: 0.2,
            },
            HshgEntry {
                id: "beta".to_string(),
                center: [2.0, 0.0, 0.0],
                radius: 0.2,
            },
        ]);

        let first = index.query_radius([0.0, 0.0, 0.0], 10.0, 10);
        let second = index.query_radius([0.0, 0.0, 0.0], 10.0, 10);
        assert_eq!(first, second);
    }
}
