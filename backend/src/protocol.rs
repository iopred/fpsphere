use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeWindow {
    pub start_tick: u64,
    pub end_tick: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SphereEntity {
    pub id: String,
    pub parent_id: Option<String>,
    pub radius: f32,
    pub position_3d: [f32; 3],
    pub dimensions: BTreeMap<String, f32>,
    pub time_window: TimeWindow,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldSnapshot {
    pub world_id: String,
    pub tick: u64,
    pub entities: Vec<SphereEntity>,
}

pub fn example_world_snapshot() -> WorldSnapshot {
    let mut world_dimensions = BTreeMap::new();
    world_dimensions.insert("money".to_string(), 0.0);

    let mut ground_dimensions = BTreeMap::new();
    ground_dimensions.insert("money".to_string(), 0.1);

    let mut building_dimensions = BTreeMap::new();
    building_dimensions.insert("money".to_string(), 0.6);

    let mut resource_dimensions = BTreeMap::new();
    resource_dimensions.insert("money".to_string(), 1.0);

    WorldSnapshot {
        world_id: "world-main".to_string(),
        tick: 0,
        entities: vec![
            SphereEntity {
                id: "sphere-world-001".to_string(),
                parent_id: None,
                radius: 60.0,
                position_3d: [0.0, 0.0, 0.0],
                dimensions: world_dimensions,
                time_window: TimeWindow {
                    start_tick: 0,
                    end_tick: None,
                },
                tags: vec!["world".to_string()],
            },
            SphereEntity {
                id: "sphere-ground-001".to_string(),
                parent_id: Some("sphere-world-001".to_string()),
                radius: 50.0,
                position_3d: [0.0, -55.0, 0.0],
                dimensions: ground_dimensions,
                time_window: TimeWindow {
                    start_tick: 0,
                    end_tick: None,
                },
                tags: vec!["ground".to_string()],
            },
            SphereEntity {
                id: "sphere-building-001".to_string(),
                parent_id: Some("sphere-world-001".to_string()),
                radius: 9.0,
                position_3d: [-12.0, -2.0, -6.0],
                dimensions: building_dimensions,
                time_window: TimeWindow {
                    start_tick: 0,
                    end_tick: None,
                },
                tags: vec!["building".to_string()],
            },
            SphereEntity {
                id: "sphere-resource-001".to_string(),
                parent_id: Some("sphere-world-001".to_string()),
                radius: 3.0,
                position_3d: [3.0, -3.0, 8.0],
                dimensions: resource_dimensions,
                time_window: TimeWindow {
                    start_tick: 0,
                    end_tick: None,
                },
                tags: vec!["resource".to_string()],
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::example_world_snapshot;

    #[test]
    fn world_snapshot_serializes_round_trip() {
        let snapshot = example_world_snapshot();
        let json = serde_json::to_string(&snapshot).expect("serialize snapshot");
        let restored: super::WorldSnapshot =
            serde_json::from_str(&json).expect("deserialize snapshot");

        assert_eq!(restored.world_id, "world-main");
        assert_eq!(restored.entities.len(), 4);
    }
}
