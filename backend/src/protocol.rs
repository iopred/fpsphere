use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitTarget {
    Master,
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommitOperation {
    Create {
        sphere: SphereEntity,
    },
    Delete {
        sphere_id: String,
    },
    Move {
        sphere_id: String,
        position_3d: [f32; 3],
    },
    UpdateDimensions {
        sphere_id: String,
        dimensions: BTreeMap<String, f32>,
    },
    UpdateRadius {
        sphere_id: String,
        radius: f32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitRequest {
    pub user_id: String,
    pub base_tick: u64,
    pub operations: Vec<CommitOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitResponse {
    pub commit_id: String,
    pub saved_to: CommitTarget,
    pub reason: Option<String>,
    pub master_tick: u64,
    pub user_tick: Option<u64>,
    pub world: WorldSnapshot,
    pub validation_errors: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum CommitFailure {
    WorldNotFound {
        message: String,
    },
    InvalidOperations {
        message: String,
        validation_errors: Vec<String>,
    },
}

impl CommitFailure {
    pub fn message(&self) -> String {
        match self {
            CommitFailure::WorldNotFound { message } => message.clone(),
            CommitFailure::InvalidOperations { message, .. } => message.clone(),
        }
    }

    pub fn validation_errors(&self) -> Vec<String> {
        match self {
            CommitFailure::WorldNotFound { .. } => Vec::new(),
            CommitFailure::InvalidOperations {
                validation_errors, ..
            } => validation_errors.clone(),
        }
    }
}

pub struct WorldRepository {
    master: WorldSnapshot,
    user_worlds: HashMap<String, WorldSnapshot>,
    commit_seq: u64,
}

impl WorldRepository {
    pub fn new(initial_world: WorldSnapshot) -> Self {
        Self {
            master: initial_world,
            user_worlds: HashMap::new(),
            commit_seq: 0,
        }
    }

    pub fn get_world_snapshot(
        &self,
        world_id: &str,
        user_id: Option<&str>,
    ) -> Option<WorldSnapshot> {
        if self.master.world_id != world_id {
            return None;
        }

        if let Some(user_id_value) = user_id {
            if let Some(snapshot) = self.user_worlds.get(user_id_value) {
                return Some(snapshot.clone());
            }
        }

        Some(self.master.clone())
    }

    pub fn list_world_ids(&self) -> Vec<String> {
        vec![self.master.world_id.clone()]
    }

    pub fn commit(
        &mut self,
        world_id: &str,
        request: CommitRequest,
    ) -> Result<CommitResponse, CommitFailure> {
        if self.master.world_id != world_id {
            return Err(CommitFailure::WorldNotFound {
                message: format!("world '{}' not found", world_id),
            });
        }

        let fallback_reason: Option<String> = if request.base_tick != self.master.tick {
            Some(format!(
                "master tick mismatch: client={} server={}",
                request.base_tick, self.master.tick
            ))
        } else {
            let mut candidate = self.master.clone();
            match apply_commit_operations(&mut candidate, &request.operations) {
                Ok(()) => {
                    candidate.tick = candidate.tick.saturating_add(1);
                    self.master = candidate.clone();
                    self.commit_seq = self.commit_seq.saturating_add(1);

                    return Ok(CommitResponse {
                        commit_id: format!("master-{}", self.commit_seq),
                        saved_to: CommitTarget::Master,
                        reason: None,
                        master_tick: self.master.tick,
                        user_tick: None,
                        world: candidate,
                        validation_errors: Vec::new(),
                    });
                }
                Err(errors) => Some(format!("master validation failed: {}", errors.join("; "))),
            }
        };

        let base_for_user = self
            .user_worlds
            .get(&request.user_id)
            .cloned()
            .unwrap_or_else(|| self.master.clone());

        let mut user_candidate = base_for_user;
        match apply_commit_operations(&mut user_candidate, &request.operations) {
            Ok(()) => {
                user_candidate.tick = user_candidate.tick.saturating_add(1);
                self.user_worlds
                    .insert(request.user_id.clone(), user_candidate.clone());
                self.commit_seq = self.commit_seq.saturating_add(1);

                Ok(CommitResponse {
                    commit_id: format!("user-{}-{}", request.user_id, self.commit_seq),
                    saved_to: CommitTarget::User,
                    reason: fallback_reason,
                    master_tick: self.master.tick,
                    user_tick: Some(user_candidate.tick),
                    world: user_candidate,
                    validation_errors: Vec::new(),
                })
            }
            Err(errors) => Err(CommitFailure::InvalidOperations {
                message: "commit rejected for both master and user branches".to_string(),
                validation_errors: errors,
            }),
        }
    }
}

fn apply_commit_operations(
    world: &mut WorldSnapshot,
    operations: &[CommitOperation],
) -> Result<(), Vec<String>> {
    for operation in operations {
        match operation {
            CommitOperation::Create { sphere } => {
                if world.entities.iter().any(|item| item.id == sphere.id) {
                    return Err(vec![format!(
                        "create failed: sphere '{}' already exists",
                        sphere.id
                    )]);
                }

                let parent_id = match &sphere.parent_id {
                    Some(value) => value,
                    None => {
                        return Err(vec![format!(
                            "create failed: sphere '{}' requires parent_id",
                            sphere.id
                        )])
                    }
                };

                if !world.entities.iter().any(|item| item.id == *parent_id) {
                    return Err(vec![format!(
                        "create failed: parent sphere '{}' does not exist",
                        parent_id
                    )]);
                }

                world.entities.push(sphere.clone());
            }

            CommitOperation::Delete { sphere_id } => {
                let index = world.entities.iter().position(|item| item.id == *sphere_id);
                let index = match index {
                    Some(value) => value,
                    None => {
                        return Err(vec![format!(
                            "delete failed: sphere '{}' does not exist",
                            sphere_id
                        )])
                    }
                };

                if world.entities[index].parent_id.is_none() {
                    return Err(vec![format!(
                        "delete failed: cannot delete root sphere '{}'",
                        sphere_id
                    )]);
                }

                world.entities.remove(index);
            }

            CommitOperation::Move {
                sphere_id,
                position_3d,
            } => {
                let entity_index = world.entities.iter().position(|item| item.id == *sphere_id);
                let entity_index = match entity_index {
                    Some(value) => value,
                    None => {
                        return Err(vec![format!(
                            "move failed: sphere '{}' does not exist",
                            sphere_id
                        )])
                    }
                };

                let previous = world.entities[entity_index].position_3d;
                let delta = [
                    position_3d[0] - previous[0],
                    position_3d[1] - previous[1],
                    position_3d[2] - previous[2],
                ];

                world.entities[entity_index].position_3d = *position_3d;

                if delta.iter().any(|value| value.abs() > f32::EPSILON) {
                    let descendant_indexes = collect_descendant_indexes(world, sphere_id);
                    for descendant_index in descendant_indexes {
                        let descendant = &mut world.entities[descendant_index];
                        descendant.position_3d = [
                            descendant.position_3d[0] + delta[0],
                            descendant.position_3d[1] + delta[1],
                            descendant.position_3d[2] + delta[2],
                        ];
                    }
                }
            }

            CommitOperation::UpdateDimensions {
                sphere_id,
                dimensions,
            } => {
                let entity = world.entities.iter_mut().find(|item| item.id == *sphere_id);
                let entity = match entity {
                    Some(value) => value,
                    None => {
                        return Err(vec![format!(
                            "update_dimensions failed: sphere '{}' does not exist",
                            sphere_id
                        )])
                    }
                };

                for (key, value) in dimensions {
                    entity.dimensions.insert(key.clone(), *value);
                }
            }

            CommitOperation::UpdateRadius { sphere_id, radius } => {
                if !radius.is_finite() || *radius <= 0.0 {
                    return Err(vec![format!(
                        "update_radius failed: radius must be > 0 for sphere '{}'",
                        sphere_id
                    )]);
                }

                let entity_index = world.entities.iter().position(|item| item.id == *sphere_id);
                let entity_index = match entity_index {
                    Some(value) => value,
                    None => {
                        return Err(vec![format!(
                            "update_radius failed: sphere '{}' does not exist",
                            sphere_id
                        )])
                    }
                };

                let previous_radius = world.entities[entity_index].radius;
                if !previous_radius.is_finite() || previous_radius <= 0.0 {
                    return Err(vec![format!(
                        "update_radius failed: sphere '{}' has invalid existing radius",
                        sphere_id
                    )]);
                }

                let scale = *radius / previous_radius;
                let center = world.entities[entity_index].position_3d;
                world.entities[entity_index].radius = *radius;

                if scale.is_finite() && scale > 0.0 && (scale - 1.0).abs() > f32::EPSILON {
                    let descendant_indexes = collect_descendant_indexes(world, sphere_id);
                    for descendant_index in descendant_indexes {
                        let descendant = &mut world.entities[descendant_index];
                        let offset_x = descendant.position_3d[0] - center[0];
                        let offset_y = descendant.position_3d[1] - center[1];
                        let offset_z = descendant.position_3d[2] - center[2];

                        descendant.position_3d = [
                            center[0] + offset_x * scale,
                            center[1] + offset_y * scale,
                            center[2] + offset_z * scale,
                        ];
                        descendant.radius = (descendant.radius * scale).max(0.01);
                    }
                }
            }
        }
    }

    Ok(())
}

fn collect_descendant_indexes(world: &WorldSnapshot, parent_id: &str) -> Vec<usize> {
    let mut indexes = Vec::new();
    let mut stack = vec![parent_id.to_string()];

    while let Some(current_parent_id) = stack.pop() {
        for (index, entity) in world.entities.iter().enumerate() {
            if entity.parent_id.as_deref() != Some(current_parent_id.as_str()) {
                continue;
            }

            indexes.push(index);
            stack.push(entity.id.clone());
        }
    }

    indexes
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

    let mut world_instance_dimensions = BTreeMap::new();
    world_instance_dimensions.insert("money".to_string(), 0.35);
    world_instance_dimensions.insert("world_template".to_string(), 1.0);
    world_instance_dimensions.insert("world_scale".to_string(), 1.0);

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
            SphereEntity {
                id: "sphere-world-instance-001".to_string(),
                parent_id: Some("sphere-world-001".to_string()),
                radius: 12.0,
                position_3d: [18.0, -2.0, 14.0],
                dimensions: world_instance_dimensions,
                time_window: TimeWindow {
                    start_tick: 0,
                    end_tick: None,
                },
                tags: vec!["world-instance".to_string()],
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::{
        example_world_snapshot, CommitOperation, CommitRequest, CommitTarget, SphereEntity,
        TimeWindow, WorldRepository,
    };
    use std::collections::BTreeMap;

    fn make_test_sphere(id: &str) -> SphereEntity {
        SphereEntity {
            id: id.to_string(),
            parent_id: Some("sphere-world-001".to_string()),
            radius: 2.0,
            position_3d: [1.0, 2.0, 3.0],
            dimensions: BTreeMap::new(),
            time_window: TimeWindow {
                start_tick: 0,
                end_tick: None,
            },
            tags: vec!["test".to_string()],
        }
    }

    fn make_child_sphere(
        id: &str,
        parent_id: &str,
        radius: f32,
        position_3d: [f32; 3],
    ) -> SphereEntity {
        SphereEntity {
            id: id.to_string(),
            parent_id: Some(parent_id.to_string()),
            radius,
            position_3d,
            dimensions: BTreeMap::new(),
            time_window: TimeWindow {
                start_tick: 0,
                end_tick: None,
            },
            tags: vec!["test".to_string()],
        }
    }

    #[test]
    fn list_world_ids_returns_master_world() {
        let repository = WorldRepository::new(example_world_snapshot());
        assert_eq!(repository.list_world_ids(), vec!["world-main".to_string()]);
    }

    #[test]
    fn commit_to_master_updates_tick() {
        let mut repository = WorldRepository::new(example_world_snapshot());

        let response = repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 0,
                    operations: vec![CommitOperation::Create {
                        sphere: make_test_sphere("sphere-user-001"),
                    }],
                },
            )
            .expect("commit should succeed");

        assert!(matches!(response.saved_to, CommitTarget::Master));
        assert_eq!(response.master_tick, 1);
        assert!(response
            .world
            .entities
            .iter()
            .any(|item| item.id == "sphere-user-001"));
    }

    #[test]
    fn tick_conflict_falls_back_to_user_branch() {
        let mut repository = WorldRepository::new(example_world_snapshot());

        repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 0,
                    operations: vec![CommitOperation::Create {
                        sphere: make_test_sphere("sphere-user-001"),
                    }],
                },
            )
            .expect("initial commit should succeed");

        let response = repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "bob".to_string(),
                    base_tick: 0,
                    operations: vec![CommitOperation::Create {
                        sphere: make_test_sphere("sphere-user-002"),
                    }],
                },
            )
            .expect("fallback commit should succeed");

        assert!(matches!(response.saved_to, CommitTarget::User));
        assert_eq!(response.master_tick, 1);
        assert_eq!(response.user_tick, Some(2));
        assert!(response.reason.is_some());
    }

    #[test]
    fn invalid_delete_is_rejected() {
        let mut repository = WorldRepository::new(example_world_snapshot());

        let result = repository.commit(
            "world-main",
            CommitRequest {
                user_id: "alice".to_string(),
                base_tick: 0,
                operations: vec![CommitOperation::Delete {
                    sphere_id: "missing-sphere".to_string(),
                }],
            },
        );

        assert!(result.is_err());
        let error = result.err().expect("error must exist");
        assert!(error
            .validation_errors()
            .iter()
            .any(|item| item.contains("does not exist")));
    }

    #[test]
    fn user_branch_can_move_sphere_it_created() {
        let mut repository = WorldRepository::new(example_world_snapshot());

        repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 0,
                    operations: vec![CommitOperation::Create {
                        sphere: make_test_sphere("sphere-user-003"),
                    }],
                },
            )
            .expect("master commit should succeed");

        let user_response = repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 0,
                    operations: vec![CommitOperation::Move {
                        sphere_id: "sphere-user-003".to_string(),
                        position_3d: [9.0, 9.0, 9.0],
                    }],
                },
            )
            .expect("user branch fallback commit should succeed");

        assert!(matches!(user_response.saved_to, CommitTarget::User));
        assert!(user_response
            .world
            .entities
            .iter()
            .any(|item| item.id == "sphere-user-003" && item.position_3d == [9.0, 9.0, 9.0]));
    }

    #[test]
    fn commit_can_update_dimensions() {
        let mut repository = WorldRepository::new(example_world_snapshot());
        let mut dimensions = BTreeMap::new();
        dimensions.insert("world_template".to_string(), 1.0);
        dimensions.insert("world_scale".to_string(), 0.5);

        let response = repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 0,
                    operations: vec![CommitOperation::UpdateDimensions {
                        sphere_id: "sphere-building-001".to_string(),
                        dimensions,
                    }],
                },
            )
            .expect("commit should update dimensions");

        let updated = response
            .world
            .entities
            .iter()
            .find(|item| item.id == "sphere-building-001")
            .expect("updated sphere");
        assert_eq!(updated.dimensions.get("world_template"), Some(&1.0));
        assert_eq!(updated.dimensions.get("world_scale"), Some(&0.5));
    }

    #[test]
    fn commit_can_update_radius() {
        let mut repository = WorldRepository::new(example_world_snapshot());

        let response = repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 0,
                    operations: vec![CommitOperation::UpdateRadius {
                        sphere_id: "sphere-building-001".to_string(),
                        radius: 14.5,
                    }],
                },
            )
            .expect("commit should update radius");

        let updated = response
            .world
            .entities
            .iter()
            .find(|item| item.id == "sphere-building-001")
            .expect("updated sphere");
        assert_eq!(updated.radius, 14.5);
    }

    #[test]
    fn move_operation_translates_descendants() {
        let mut repository = WorldRepository::new(example_world_snapshot());

        repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 0,
                    operations: vec![CommitOperation::Create {
                        sphere: make_child_sphere(
                            "sphere-world-instance-child-001",
                            "sphere-world-instance-001",
                            2.0,
                            [21.0, -3.0, 19.0],
                        ),
                    }],
                },
            )
            .expect("child create should succeed");

        let response = repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 1,
                    operations: vec![CommitOperation::Move {
                        sphere_id: "sphere-world-instance-001".to_string(),
                        position_3d: [23.0, -1.0, 8.0],
                    }],
                },
            )
            .expect("move should succeed");

        let moved_child = response
            .world
            .entities
            .iter()
            .find(|item| item.id == "sphere-world-instance-child-001")
            .expect("moved child");

        assert_eq!(moved_child.position_3d, [26.0, -2.0, 13.0]);
    }

    #[test]
    fn update_radius_scales_descendants() {
        let mut repository = WorldRepository::new(example_world_snapshot());

        repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 0,
                    operations: vec![CommitOperation::Create {
                        sphere: make_child_sphere(
                            "sphere-world-instance-child-002",
                            "sphere-world-instance-001",
                            2.0,
                            [21.0, -3.0, 19.0],
                        ),
                    }],
                },
            )
            .expect("child create should succeed");

        let response = repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 1,
                    operations: vec![CommitOperation::UpdateRadius {
                        sphere_id: "sphere-world-instance-001".to_string(),
                        radius: 24.0,
                    }],
                },
            )
            .expect("radius update should succeed");

        let scaled_child = response
            .world
            .entities
            .iter()
            .find(|item| item.id == "sphere-world-instance-child-002")
            .expect("scaled child");

        assert_eq!(scaled_child.radius, 4.0);
        assert_eq!(scaled_child.position_3d, [24.0, -4.0, 24.0]);
    }
}
