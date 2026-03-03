use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

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

#[derive(Debug, Clone, Copy, Default)]
pub struct TemporalWorldQuery {
    pub tick: Option<u64>,
    pub window_start_tick: Option<u64>,
    pub window_end_tick: Option<u64>,
}

impl TemporalWorldQuery {
    pub fn is_empty(&self) -> bool {
        self.tick.is_none() && self.window_start_tick.is_none() && self.window_end_tick.is_none()
    }

    pub fn validate(&self) -> Result<(), String> {
        let (window_start_tick, window_end_tick) = match (self.window_start_tick, self.window_end_tick) {
            (None, Some(_)) => {
                return Err("window_end_tick requires window_start_tick".to_string())
            }
            (Some(start_tick), Some(end_tick)) if end_tick < start_tick => {
                return Err("window_end_tick must be >= window_start_tick".to_string())
            }
            values => values,
        };

        if let Some(tick) = self.tick {
            if window_start_tick.is_some_and(|start_tick| tick < start_tick) {
                return Err("tick must be >= window_start_tick when both are provided".to_string());
            }
            if window_end_tick.is_some_and(|end_tick| tick > end_tick) {
                return Err("tick must be <= window_end_tick when both are provided".to_string());
            }
        }

        Ok(())
    }
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
    pub world: WorldSnapshot,
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

#[derive(Debug, Clone)]
pub enum WorldMutationFailure {
    InvalidWorldId { message: String },
    WorldAlreadyExists { message: String },
    WorldNotFound { message: String },
    LastWorldRemovalForbidden { message: String },
}

impl WorldMutationFailure {
    pub fn message(&self) -> String {
        match self {
            WorldMutationFailure::InvalidWorldId { message } => message.clone(),
            WorldMutationFailure::WorldAlreadyExists { message } => message.clone(),
            WorldMutationFailure::WorldNotFound { message } => message.clone(),
            WorldMutationFailure::LastWorldRemovalForbidden { message } => message.clone(),
        }
    }
}

pub struct WorldRepository {
    masters: HashMap<String, WorldSnapshot>,
    user_worlds: HashMap<(String, String), WorldSnapshot>,
    commit_seq: u64,
}

impl WorldRepository {
    pub fn new(initial_world: WorldSnapshot) -> Self {
        let world_id = initial_world.world_id.clone();
        let mut masters = HashMap::new();
        masters.insert(world_id, initial_world);

        Self {
            masters,
            user_worlds: HashMap::new(),
            commit_seq: 0,
        }
    }

    pub fn get_world_snapshot(
        &self,
        world_id: &str,
        user_id: Option<&str>,
    ) -> Option<WorldSnapshot> {
        self.get_world_snapshot_with_query(world_id, user_id, None)
    }

    pub fn get_world_snapshot_with_query(
        &self,
        world_id: &str,
        user_id: Option<&str>,
        temporal_query: Option<TemporalWorldQuery>,
    ) -> Option<WorldSnapshot> {
        if let Some(user_id_value) = user_id {
            if let Some(snapshot) = self
                .user_worlds
                .get(&(world_id.to_string(), user_id_value.to_string()))
            {
                let mut projected = snapshot.clone();
                compact_shared_template_legacy_descendants(&mut projected);
                return Some(filter_world_snapshot_by_time_window(
                    projected,
                    temporal_query.unwrap_or_default(),
                ));
            }
        }

        self.masters.get(world_id).cloned().map(|snapshot| {
            let mut snapshot = snapshot;
            compact_shared_template_legacy_descendants(&mut snapshot);
            filter_world_snapshot_by_time_window(snapshot, temporal_query.unwrap_or_default())
        })
    }

    pub fn list_world_ids(&self) -> Vec<String> {
        let mut world_ids = self.masters.keys().cloned().collect::<Vec<_>>();
        world_ids.sort();
        world_ids
    }

    fn validate_world_id(world_id: &str) -> Result<(), WorldMutationFailure> {
        let trimmed = world_id.trim();
        if trimmed.is_empty() {
            return Err(WorldMutationFailure::InvalidWorldId {
                message: "world_id is required".to_string(),
            });
        }

        if trimmed.len() > 64 {
            return Err(WorldMutationFailure::InvalidWorldId {
                message: "world_id must be <= 64 characters".to_string(),
            });
        }

        if !trimmed.chars().all(|value| {
            value.is_ascii_alphanumeric() || value == '-' || value == '_' || value == '.'
        }) {
            return Err(WorldMutationFailure::InvalidWorldId {
                message: "world_id may only include ASCII letters, numbers, '-', '_', or '.'"
                    .to_string(),
            });
        }

        Ok(())
    }

    pub fn create_world(
        &mut self,
        world_id_input: &str,
    ) -> Result<WorldSnapshot, WorldMutationFailure> {
        Self::validate_world_id(world_id_input)?;
        let world_id = world_id_input.trim().to_string();
        if self.masters.contains_key(&world_id) {
            return Err(WorldMutationFailure::WorldAlreadyExists {
                message: format!("world '{}' already exists", world_id),
            });
        }

        let template = self
            .masters
            .get("world-main")
            .or_else(|| self.masters.values().next())
            .cloned()
            .ok_or_else(|| WorldMutationFailure::WorldNotFound {
                message: "unable to create world: no source world exists".to_string(),
            })?;

        let mut next_world = template;
        next_world.world_id = world_id.clone();
        next_world.tick = 0;
        compact_shared_template_legacy_descendants(&mut next_world);

        self.masters.insert(world_id, next_world.clone());
        Ok(next_world)
    }

    pub fn delete_world(&mut self, world_id_input: &str) -> Result<(), WorldMutationFailure> {
        let world_id = world_id_input.trim();
        if !self.masters.contains_key(world_id) {
            return Err(WorldMutationFailure::WorldNotFound {
                message: format!("world '{}' not found", world_id),
            });
        }

        if self.masters.len() <= 1 {
            return Err(WorldMutationFailure::LastWorldRemovalForbidden {
                message: "cannot delete the last remaining world".to_string(),
            });
        }

        self.masters.remove(world_id);
        self.user_worlds
            .retain(|(branch_world_id, _), _| branch_world_id != world_id);
        Ok(())
    }

    pub fn commit(
        &mut self,
        world_id: &str,
        request: CommitRequest,
    ) -> Result<CommitResponse, CommitFailure> {
        let master = match self.masters.get(world_id) {
            Some(snapshot) => snapshot.clone(),
            None => {
                return Err(CommitFailure::WorldNotFound {
                    message: format!("world '{}' not found", world_id),
                })
            }
        };

        let fallback_reason: Option<String> = if request.base_tick != master.tick {
            Some(format!(
                "master tick mismatch: client={} server={}",
                request.base_tick, master.tick
            ))
        } else {
            let mut candidate = master.clone();
            match apply_commit_operations(&mut candidate, &request.operations) {
                Ok(()) => {
                    candidate.tick = candidate.tick.saturating_add(1);
                    compact_shared_template_legacy_descendants(&mut candidate);
                    self.masters.insert(world_id.to_string(), candidate.clone());
                    self.commit_seq = self.commit_seq.saturating_add(1);

                    return Ok(CommitResponse {
                        commit_id: format!("master-{}", self.commit_seq),
                        saved_to: CommitTarget::Master,
                        reason: None,
                        world: candidate,
                    });
                }
                Err(errors) => Some(format!("master validation failed: {}", errors.join("; "))),
            }
        };

        let user_branch_key = (world_id.to_string(), request.user_id.clone());
        let base_for_user = self
            .user_worlds
            .get(&user_branch_key)
            .cloned()
            .unwrap_or_else(|| master.clone());

        let mut user_candidate = base_for_user;
        match apply_commit_operations(&mut user_candidate, &request.operations) {
            Ok(()) => {
                user_candidate.tick = user_candidate.tick.saturating_add(1);
                compact_shared_template_legacy_descendants(&mut user_candidate);
                self.user_worlds
                    .insert(user_branch_key, user_candidate.clone());
                self.commit_seq = self.commit_seq.saturating_add(1);

                Ok(CommitResponse {
                    commit_id: format!("user-{}-{}", request.user_id, self.commit_seq),
                    saved_to: CommitTarget::User,
                    reason: fallback_reason,
                    world: user_candidate,
                })
            }
            Err(errors) => Err(CommitFailure::InvalidOperations {
                message: "commit rejected for both master and user branches".to_string(),
                validation_errors: errors,
            }),
        }
    }
}

fn is_entity_active_at_tick(entity: &SphereEntity, tick: u64) -> bool {
    if tick < entity.time_window.start_tick {
        return false;
    }

    entity
        .time_window
        .end_tick
        .map_or(true, |end_tick| tick <= end_tick)
}

fn does_entity_overlap_window(
    entity: &SphereEntity,
    window_start_tick: u64,
    window_end_tick: Option<u64>,
) -> bool {
    let entity_start_tick = entity.time_window.start_tick;
    let entity_end_tick = entity.time_window.end_tick;

    if let Some(end_tick) = window_end_tick {
        if entity_start_tick > end_tick {
            return false;
        }
    }

    entity_end_tick.map_or(true, |end_tick| end_tick >= window_start_tick)
}

fn is_entity_time_visible(entity: &SphereEntity, query: TemporalWorldQuery) -> bool {
    if let Some(tick) = query.tick {
        if !is_entity_active_at_tick(entity, tick) {
            return false;
        }
    }

    if let Some(window_start_tick) = query.window_start_tick {
        if !does_entity_overlap_window(entity, window_start_tick, query.window_end_tick) {
            return false;
        }
    }

    true
}

fn filter_world_snapshot_by_time_window(
    snapshot: WorldSnapshot,
    query: TemporalWorldQuery,
) -> WorldSnapshot {
    if query.is_empty() {
        return snapshot;
    }

    let mut included_ids = snapshot
        .entities
        .iter()
        .filter(|entity| entity.parent_id.is_none())
        .map(|entity| entity.id.clone())
        .collect::<HashSet<_>>();

    let mut changed = true;
    while changed {
        changed = false;
        for entity in &snapshot.entities {
            if included_ids.contains(&entity.id) {
                continue;
            }

            let Some(parent_id) = entity.parent_id.as_deref() else {
                continue;
            };
            if !included_ids.contains(parent_id) {
                continue;
            }
            if !is_entity_time_visible(entity, query) {
                continue;
            }

            included_ids.insert(entity.id.clone());
            changed = true;
        }
    }

    WorldSnapshot {
        world_id: snapshot.world_id,
        tick: snapshot.tick,
        entities: snapshot
            .entities
            .into_iter()
            .filter(|entity| included_ids.contains(&entity.id))
            .collect(),
    }
}

const WORLD_TEMPLATE_DIMENSION: &str = "world_template";
const TEMPLATE_ROOT_TAG: &str = "template-root";

fn read_template_id(entity: &SphereEntity) -> Option<i32> {
    let value = *entity.dimensions.get(WORLD_TEMPLATE_DIMENSION)?;
    if !value.is_finite() {
        return None;
    }

    let truncated = value.trunc();
    if truncated <= 0.0 || truncated > i32::MAX as f32 {
        return None;
    }

    Some(truncated as i32)
}

fn compact_shared_template_legacy_descendants(world: &mut WorldSnapshot) {
    if world.entities.len() < 2 {
        return;
    }

    let mut children_by_parent: HashMap<String, Vec<String>> = HashMap::new();
    for entity in &world.entities {
        if let Some(parent_id) = &entity.parent_id {
            children_by_parent
                .entry(parent_id.clone())
                .or_default()
                .push(entity.id.clone());
        }
    }

    let mut template_root_ids: HashSet<String> = HashSet::new();
    let mut template_ids_with_shared_definition: HashSet<i32> = HashSet::new();

    for entity in &world.entities {
        if !entity.tags.iter().any(|tag| tag == TEMPLATE_ROOT_TAG) {
            continue;
        }

        template_root_ids.insert(entity.id.clone());

        let template_id = match read_template_id(entity) {
            Some(value) => value,
            None => continue,
        };

        if let Some(children) = children_by_parent.get(&entity.id) {
            if !children.is_empty() {
                template_ids_with_shared_definition.insert(template_id);
            }
        }
    }

    if template_ids_with_shared_definition.is_empty() {
        return;
    }

    let mut remove_ids: HashSet<String> = HashSet::new();

    for entity in &world.entities {
        if template_root_ids.contains(&entity.id) {
            continue;
        }

        let template_id = match read_template_id(entity) {
            Some(value) => value,
            None => continue,
        };

        if !template_ids_with_shared_definition.contains(&template_id) {
            continue;
        }

        let mut stack = children_by_parent
            .get(&entity.id)
            .cloned()
            .unwrap_or_default();

        while let Some(descendant_id) = stack.pop() {
            if template_root_ids.contains(&descendant_id) {
                continue;
            }

            if !remove_ids.insert(descendant_id.clone()) {
                continue;
            }

            if let Some(children) = children_by_parent.get(&descendant_id) {
                for child_id in children {
                    stack.push(child_id.clone());
                }
            }
        }
    }

    if remove_ids.is_empty() {
        return;
    }

    world
        .entities
        .retain(|entity| !remove_ids.contains(&entity.id));
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

                if world
                    .entities
                    .iter()
                    .any(|item| item.parent_id.as_deref() == Some(sphere_id.as_str()))
                {
                    return Err(vec![format!(
                        "delete failed: sphere '{}' has child spheres",
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
        TemporalWorldQuery, TimeWindow, WorldMutationFailure, WorldRepository,
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

    fn make_template_root_sphere(template_id: i32) -> SphereEntity {
        let mut dimensions = BTreeMap::new();
        dimensions.insert("money".to_string(), 0.0);
        dimensions.insert("world_template".to_string(), template_id as f32);
        dimensions.insert("world_scale".to_string(), 1.0);

        SphereEntity {
            id: format!("sphere-template-root-{}", template_id),
            parent_id: Some("sphere-world-001".to_string()),
            radius: 12.0,
            position_3d: [0.0, 0.0, 0.0],
            dimensions,
            time_window: TimeWindow {
                start_tick: 0,
                end_tick: None,
            },
            tags: vec![
                "template-root".to_string(),
                format!("template-{}", template_id),
            ],
        }
    }

    fn make_template_definition_sphere(id: &str, parent_id: &str) -> SphereEntity {
        let mut dimensions = BTreeMap::new();
        dimensions.insert("money".to_string(), 0.5);

        SphereEntity {
            id: id.to_string(),
            parent_id: Some(parent_id.to_string()),
            radius: 1.2,
            position_3d: [0.0, -1.0, 0.0],
            dimensions,
            time_window: TimeWindow {
                start_tick: 0,
                end_tick: None,
            },
            tags: vec!["template-definition".to_string()],
        }
    }

    fn make_template_host_sphere(id: &str, template_id: i32, parent_id: &str) -> SphereEntity {
        let mut dimensions = BTreeMap::new();
        dimensions.insert("money".to_string(), 0.2);
        dimensions.insert("world_template".to_string(), template_id as f32);
        dimensions.insert("world_scale".to_string(), 1.0);

        SphereEntity {
            id: id.to_string(),
            parent_id: Some(parent_id.to_string()),
            radius: 4.0,
            position_3d: [1.5, -1.2, 2.2],
            dimensions,
            time_window: TimeWindow {
                start_tick: 0,
                end_tick: None,
            },
            tags: vec!["world-instance".to_string()],
        }
    }

    fn make_time_windowed_sphere(
        id: &str,
        parent_id: &str,
        start_tick: u64,
        end_tick: Option<u64>,
    ) -> SphereEntity {
        SphereEntity {
            id: id.to_string(),
            parent_id: Some(parent_id.to_string()),
            radius: 2.0,
            position_3d: [0.0, 0.0, 0.0],
            dimensions: BTreeMap::new(),
            time_window: TimeWindow {
                start_tick,
                end_tick,
            },
            tags: vec!["temporal-test".to_string()],
        }
    }

    #[test]
    fn list_world_ids_returns_master_world() {
        let repository = WorldRepository::new(example_world_snapshot());
        assert_eq!(repository.list_world_ids(), vec!["world-main".to_string()]);
    }

    #[test]
    fn create_world_adds_world_and_is_listed() {
        let mut repository = WorldRepository::new(example_world_snapshot());
        let created = repository
            .create_world("world-beta")
            .expect("create world should succeed");

        assert_eq!(created.world_id, "world-beta");
        assert_eq!(
            repository.list_world_ids(),
            vec!["world-beta".to_string(), "world-main".to_string()]
        );

        let loaded = repository
            .get_world_snapshot("world-beta", None)
            .expect("created world should be readable");
        assert_eq!(loaded.world_id, "world-beta");
        assert_eq!(loaded.tick, 0);
    }

    #[test]
    fn create_world_rejects_invalid_ids() {
        let mut repository = WorldRepository::new(example_world_snapshot());
        let result = repository.create_world("invalid level id!");
        assert!(matches!(
            result,
            Err(WorldMutationFailure::InvalidWorldId { .. })
        ));
    }

    #[test]
    fn get_world_snapshot_compacts_legacy_template_descendants() {
        let mut world = example_world_snapshot();
        let template_root = make_template_root_sphere(1);
        let template_definition = make_template_definition_sphere(
            "sphere-template-root-1::definition-001",
            &template_root.id,
        );
        let legacy_child = make_child_sphere(
            "sphere-legacy-host-child-001",
            "sphere-world-instance-001",
            1.4,
            [18.8, -2.2, 14.2],
        );
        let legacy_grandchild = make_child_sphere(
            "sphere-legacy-host-grandchild-001",
            "sphere-legacy-host-child-001",
            0.7,
            [19.1, -2.0, 14.6],
        );

        world.entities.push(template_root);
        world.entities.push(template_definition);
        world.entities.push(legacy_child);
        world.entities.push(legacy_grandchild);

        let repository = WorldRepository::new(world);
        let snapshot = repository
            .get_world_snapshot("world-main", None)
            .expect("snapshot should be present");

        assert!(snapshot
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-template-root-1::definition-001"));
        assert!(!snapshot
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-legacy-host-child-001"));
        assert!(!snapshot
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-legacy-host-grandchild-001"));
    }

    #[test]
    fn temporal_world_query_validation_rules() {
        let missing_start = TemporalWorldQuery {
            tick: None,
            window_start_tick: None,
            window_end_tick: Some(5),
        };
        assert!(missing_start.validate().is_err());

        let reversed_window = TemporalWorldQuery {
            tick: None,
            window_start_tick: Some(9),
            window_end_tick: Some(8),
        };
        assert!(reversed_window.validate().is_err());

        let out_of_range_tick = TemporalWorldQuery {
            tick: Some(10),
            window_start_tick: Some(1),
            window_end_tick: Some(9),
        };
        assert!(out_of_range_tick.validate().is_err());

        let valid = TemporalWorldQuery {
            tick: Some(8),
            window_start_tick: Some(1),
            window_end_tick: Some(9),
        };
        assert!(valid.validate().is_ok());
    }

    #[test]
    fn get_world_snapshot_with_tick_filters_by_time_window() {
        let mut world = example_world_snapshot();
        world.entities.push(make_time_windowed_sphere(
            "sphere-temporal-future-001",
            "sphere-world-001",
            10,
            None,
        ));
        world.entities.push(make_time_windowed_sphere(
            "sphere-temporal-expired-001",
            "sphere-world-001",
            0,
            Some(3),
        ));

        let repository = WorldRepository::new(world);
        let snapshot = repository
            .get_world_snapshot_with_query(
                "world-main",
                None,
                Some(TemporalWorldQuery {
                    tick: Some(5),
                    window_start_tick: None,
                    window_end_tick: None,
                }),
            )
            .expect("snapshot should be present");

        assert!(snapshot
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-building-001"));
        assert!(!snapshot
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-temporal-future-001"));
        assert!(!snapshot
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-temporal-expired-001"));
    }

    #[test]
    fn get_world_snapshot_with_window_filters_by_overlap_and_parent_visibility() {
        let mut world = example_world_snapshot();
        world.entities.push(make_time_windowed_sphere(
            "sphere-window-overlap-001",
            "sphere-world-001",
            3,
            Some(9),
        ));
        world.entities.push(make_time_windowed_sphere(
            "sphere-window-outside-001",
            "sphere-world-001",
            10,
            Some(14),
        ));

        let hidden_parent = make_time_windowed_sphere(
            "sphere-window-parent-hidden-001",
            "sphere-world-001",
            20,
            None,
        );
        let hidden_child = make_time_windowed_sphere(
            "sphere-window-child-should-hide-001",
            &hidden_parent.id,
            0,
            None,
        );
        world.entities.push(hidden_parent);
        world.entities.push(hidden_child);

        let repository = WorldRepository::new(world);
        let snapshot = repository
            .get_world_snapshot_with_query(
                "world-main",
                None,
                Some(TemporalWorldQuery {
                    tick: None,
                    window_start_tick: Some(4),
                    window_end_tick: Some(8),
                }),
            )
            .expect("snapshot should be present");

        assert!(snapshot
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-window-overlap-001"));
        assert!(!snapshot
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-window-outside-001"));
        assert!(!snapshot
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-window-parent-hidden-001"));
        assert!(!snapshot
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-window-child-should-hide-001"));
    }

    #[test]
    fn temporal_query_is_deterministic_with_unordered_parent_child_entities() {
        let mut world = example_world_snapshot();
        let visible_child = make_time_windowed_sphere(
            "sphere-temporal-child-before-parent-001",
            "sphere-temporal-parent-visible-001",
            4,
            Some(9),
        );
        let visible_parent = make_time_windowed_sphere(
            "sphere-temporal-parent-visible-001",
            "sphere-world-001",
            3,
            Some(9),
        );
        let hidden_parent = make_time_windowed_sphere(
            "sphere-temporal-parent-hidden-001",
            "sphere-world-001",
            20,
            None,
        );
        let hidden_child = make_time_windowed_sphere(
            "sphere-temporal-child-hidden-parent-001",
            "sphere-temporal-parent-hidden-001",
            0,
            None,
        );

        // Purposefully insert child before parent to prove filtering is order-stable.
        world.entities.push(visible_child);
        world.entities.push(hidden_parent);
        world.entities.push(hidden_child);
        world.entities.push(visible_parent);

        let repository = WorldRepository::new(world);
        let query = TemporalWorldQuery {
            tick: Some(6),
            window_start_tick: Some(4),
            window_end_tick: Some(8),
        };

        let snapshot_a = repository
            .get_world_snapshot_with_query("world-main", None, Some(query))
            .expect("snapshot should be present");
        let snapshot_b = repository
            .get_world_snapshot_with_query("world-main", None, Some(query))
            .expect("snapshot should be present");

        let ids_a = snapshot_a
            .entities
            .iter()
            .map(|entity| entity.id.clone())
            .collect::<Vec<_>>();
        let ids_b = snapshot_b
            .entities
            .iter()
            .map(|entity| entity.id.clone())
            .collect::<Vec<_>>();

        assert_eq!(ids_a, ids_b);
        assert!(ids_a
            .iter()
            .any(|entity_id| entity_id == "sphere-temporal-parent-visible-001"));
        assert!(ids_a
            .iter()
            .any(|entity_id| entity_id == "sphere-temporal-child-before-parent-001"));
        assert!(!ids_a
            .iter()
            .any(|entity_id| entity_id == "sphere-temporal-parent-hidden-001"));
        assert!(!ids_a
            .iter()
            .any(|entity_id| entity_id == "sphere-temporal-child-hidden-parent-001"));
    }

    #[test]
    fn temporal_query_tick_only_matches_tick_with_enclosing_window() {
        let mut world = example_world_snapshot();
        world.entities.push(make_time_windowed_sphere(
            "sphere-temporal-windowed-002",
            "sphere-world-001",
            2,
            Some(12),
        ));
        world.entities.push(make_time_windowed_sphere(
            "sphere-temporal-future-002",
            "sphere-world-001",
            20,
            None,
        ));

        let repository = WorldRepository::new(world);
        let tick_only = repository
            .get_world_snapshot_with_query(
                "world-main",
                None,
                Some(TemporalWorldQuery {
                    tick: Some(6),
                    window_start_tick: None,
                    window_end_tick: None,
                }),
            )
            .expect("tick-only snapshot should be present");
        let tick_with_window = repository
            .get_world_snapshot_with_query(
                "world-main",
                None,
                Some(TemporalWorldQuery {
                    tick: Some(6),
                    window_start_tick: Some(4),
                    window_end_tick: Some(8),
                }),
            )
            .expect("tick+window snapshot should be present");

        let tick_only_ids = tick_only
            .entities
            .iter()
            .map(|entity| entity.id.clone())
            .collect::<Vec<_>>();
        let tick_with_window_ids = tick_with_window
            .entities
            .iter()
            .map(|entity| entity.id.clone())
            .collect::<Vec<_>>();

        assert_eq!(tick_only_ids, tick_with_window_ids);
    }

    #[test]
    fn commit_compacts_legacy_template_descendants_when_shared_definition_exists() {
        let mut repository = WorldRepository::new(example_world_snapshot());

        let template_root = make_template_root_sphere(1);
        let template_definition = make_template_definition_sphere(
            "sphere-template-root-1::definition-002",
            &template_root.id,
        );
        let legacy_child = make_child_sphere(
            "sphere-legacy-host-child-002",
            "sphere-world-instance-001",
            1.4,
            [18.5, -2.4, 13.7],
        );
        let legacy_grandchild = make_child_sphere(
            "sphere-legacy-host-grandchild-002",
            "sphere-legacy-host-child-002",
            0.7,
            [18.9, -2.1, 13.9],
        );

        let response = repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 0,
                    operations: vec![
                        CommitOperation::Create {
                            sphere: template_root,
                        },
                        CommitOperation::Create {
                            sphere: template_definition,
                        },
                        CommitOperation::Create {
                            sphere: legacy_child,
                        },
                        CommitOperation::Create {
                            sphere: legacy_grandchild,
                        },
                    ],
                },
            )
            .expect("commit should succeed");

        assert!(response
            .world
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-template-root-1::definition-002"));
        assert!(!response
            .world
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-legacy-host-child-002"));
        assert!(!response
            .world
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-legacy-host-grandchild-002"));
    }

    #[test]
    fn commit_keeps_host_descendants_without_shared_template_definition() {
        let mut repository = WorldRepository::new(example_world_snapshot());
        let host = make_template_host_sphere("sphere-template-host-099", 99, "sphere-world-001");
        let host_child = make_child_sphere(
            "sphere-template-host-099-child-001",
            "sphere-template-host-099",
            0.8,
            [1.8, -1.3, 2.5],
        );

        let response = repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 0,
                    operations: vec![
                        CommitOperation::Create { sphere: host },
                        CommitOperation::Create { sphere: host_child },
                    ],
                },
            )
            .expect("commit should succeed");

        assert!(response
            .world
            .entities
            .iter()
            .any(|entity| entity.id == "sphere-template-host-099-child-001"));
    }

    #[test]
    fn delete_world_removes_master_and_user_branch() {
        let mut repository = WorldRepository::new(example_world_snapshot());
        repository
            .create_world("world-beta")
            .expect("create world should succeed");

        repository
            .commit(
                "world-beta",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 99,
                    operations: vec![CommitOperation::Create {
                        sphere: make_test_sphere("sphere-user-beta-001"),
                    }],
                },
            )
            .expect("fallback user commit should succeed");

        repository
            .delete_world("world-beta")
            .expect("delete world should succeed");

        assert_eq!(repository.list_world_ids(), vec!["world-main".to_string()]);
        assert!(repository.get_world_snapshot("world-beta", None).is_none());
        assert!(repository
            .get_world_snapshot("world-beta", Some("alice"))
            .is_none());
    }

    #[test]
    fn delete_world_rejects_removing_last_world() {
        let mut repository = WorldRepository::new(example_world_snapshot());
        let result = repository.delete_world("world-main");
        assert!(matches!(
            result,
            Err(WorldMutationFailure::LastWorldRemovalForbidden { .. })
        ));
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
        assert_eq!(response.world.tick, 1);
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
        assert_eq!(response.world.tick, 2);
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
    fn delete_parent_with_children_is_rejected() {
        let mut repository = WorldRepository::new(example_world_snapshot());

        repository
            .commit(
                "world-main",
                CommitRequest {
                    user_id: "alice".to_string(),
                    base_tick: 0,
                    operations: vec![CommitOperation::Create {
                        sphere: make_child_sphere(
                            "sphere-building-001-child-001",
                            "sphere-building-001",
                            1.5,
                            [-11.0, -1.0, -6.5],
                        ),
                    }],
                },
            )
            .expect("child create should succeed");

        let result = repository.commit(
            "world-main",
            CommitRequest {
                user_id: "alice".to_string(),
                base_tick: 1,
                operations: vec![CommitOperation::Delete {
                    sphere_id: "sphere-building-001".to_string(),
                }],
            },
        );

        assert!(result.is_err());
        let error = result.err().expect("error must exist");
        assert!(error
            .validation_errors()
            .iter()
            .any(|item| item.contains("has child spheres")));
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
