#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AoiDomain {
    Players,
    #[allow(dead_code)]
    WorldEntities,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AoiPolicy {
    pub partition_cell_edge: f32,
    pub player_radius: f32,
    pub world_entity_radius: f32,
    pub max_players: usize,
    pub max_world_entities: usize,
}

impl Default for AoiPolicy {
    fn default() -> Self {
        Self {
            partition_cell_edge: 24.0,
            player_radius: 48.0,
            world_entity_radius: 36.0,
            max_players: 24,
            max_world_entities: 96,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AoiQuery {
    pub center: [f32; 3],
    pub radius: f32,
    pub max_results: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AoiPartitionKey {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

impl AoiPolicy {
    pub fn query_for(self, domain: AoiDomain, center: [f32; 3]) -> AoiQuery {
        match domain {
            AoiDomain::Players => AoiQuery {
                center,
                radius: sanitize_radius(self.player_radius),
                max_results: self.max_players,
            },
            AoiDomain::WorldEntities => AoiQuery {
                center,
                radius: sanitize_radius(self.world_entity_radius),
                max_results: self.max_world_entities,
            },
        }
    }
}

fn sanitize_cell_edge(cell_edge: f32) -> f32 {
    if cell_edge.is_finite() && cell_edge > 0.0 {
        cell_edge
    } else {
        1.0
    }
}

fn sanitize_radius(radius: f32) -> f32 {
    if radius.is_finite() && radius > 0.0 {
        radius
    } else {
        0.0
    }
}

fn quantize_axis(value: f32, edge: f32) -> i32 {
    if !value.is_finite() {
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

pub fn partition_key(position: [f32; 3], cell_edge: f32) -> AoiPartitionKey {
    let edge = sanitize_cell_edge(cell_edge);
    AoiPartitionKey {
        x: quantize_axis(position[0], edge),
        y: quantize_axis(position[1], edge),
        z: quantize_axis(position[2], edge),
    }
}

pub fn covering_partition_keys(query: AoiQuery, cell_edge: f32) -> Vec<AoiPartitionKey> {
    let edge = sanitize_cell_edge(cell_edge);
    let radius = sanitize_radius(query.radius);
    let min = [
        query.center[0] - radius,
        query.center[1] - radius,
        query.center[2] - radius,
    ];
    let max = [
        query.center[0] + radius,
        query.center[1] + radius,
        query.center[2] + radius,
    ];

    let min_key = partition_key(min, edge);
    let max_key = partition_key(max, edge);
    let mut keys = Vec::new();
    for x in min_key.x..=max_key.x {
        for y in min_key.y..=max_key.y {
            for z in min_key.z..=max_key.z {
                keys.push(AoiPartitionKey { x, y, z });
            }
        }
    }
    keys
}

fn distance_squared(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let dz = b[2] - a[2];
    dx * dx + dy * dy + dz * dz
}

pub fn select_ids_in_query<'a, T: 'a, FPos, FId>(
    entries: impl IntoIterator<Item = &'a T>,
    query: AoiQuery,
    exclude_id: Option<&str>,
    position_of: FPos,
    id_of: FId,
) -> Vec<String>
where
    FPos: Fn(&T) -> [f32; 3],
    FId: Fn(&T) -> &str,
{
    if query.max_results == 0 {
        return Vec::new();
    }

    let radius = sanitize_radius(query.radius);
    let radius_sq = radius * radius;
    let mut matches = Vec::<(String, f32)>::new();

    for entry in entries {
        let entry_id = id_of(entry);
        if exclude_id.is_some_and(|target| target == entry_id) {
            continue;
        }

        let position = position_of(entry);
        if !position[0].is_finite() || !position[1].is_finite() || !position[2].is_finite() {
            continue;
        }

        let dist_sq = distance_squared(query.center, position);
        if dist_sq <= radius_sq {
            matches.push((entry_id.to_string(), dist_sq));
        }
    }

    matches.sort_by(|left, right| {
        left.1
            .total_cmp(&right.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    matches.truncate(query.max_results);
    matches.into_iter().map(|(entry_id, _)| entry_id).collect()
}

#[cfg(test)]
mod tests {
    use super::{
        covering_partition_keys, partition_key, select_ids_in_query, AoiDomain, AoiPartitionKey,
        AoiPolicy,
    };

    #[derive(Debug)]
    struct TestEntry {
        id: &'static str,
        position: [f32; 3],
    }

    #[test]
    fn partition_key_quantizes_negative_and_positive_axes() {
        assert_eq!(
            partition_key([23.9, -0.1, -24.0], 24.0),
            AoiPartitionKey { x: 0, y: -1, z: -1 }
        );
        assert_eq!(
            partition_key([24.0, -24.0, 48.1], 24.0),
            AoiPartitionKey { x: 1, y: -1, z: 2 }
        );
    }

    #[test]
    fn covering_partition_keys_returns_full_cube_for_query_radius() {
        let policy = AoiPolicy::default();
        let keys = covering_partition_keys(
            policy.query_for(AoiDomain::Players, [0.0, 0.0, 0.0]),
            policy.partition_cell_edge,
        );

        // player radius 48, edge 24 => [-2..2] across each axis => 125 cells.
        assert_eq!(keys.len(), 125);
        assert!(keys.contains(&AoiPartitionKey { x: -2, y: -2, z: -2 }));
        assert!(keys.contains(&AoiPartitionKey { x: 2, y: 2, z: 2 }));
    }

    #[test]
    fn select_ids_in_query_orders_by_distance_then_id() {
        let entries = vec![
            TestEntry {
                id: "b",
                position: [1.0, 0.0, 0.0],
            },
            TestEntry {
                id: "a",
                position: [-1.0, 0.0, 0.0],
            },
            TestEntry {
                id: "c",
                position: [0.0, 2.0, 0.0],
            },
            TestEntry {
                id: "d",
                position: [0.0, 0.0, 40.0],
            },
        ];

        let query = AoiPolicy::default().query_for(AoiDomain::WorldEntities, [0.0, 0.0, 0.0]);
        let ids = select_ids_in_query(
            entries.iter(),
            query,
            None,
            |entry| entry.position,
            |entry| entry.id,
        );

        assert_eq!(ids, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn select_ids_in_query_applies_exclusion_and_limit() {
        let entries = vec![
            TestEntry {
                id: "alpha",
                position: [0.0, 0.0, 0.0],
            },
            TestEntry {
                id: "beta",
                position: [0.0, 1.0, 0.0],
            },
            TestEntry {
                id: "gamma",
                position: [0.0, 2.0, 0.0],
            },
        ];

        let mut policy = AoiPolicy::default();
        policy.max_players = 2;
        let ids = select_ids_in_query(
            entries.iter(),
            policy.query_for(AoiDomain::Players, [0.0, 0.0, 0.0]),
            Some("alpha"),
            |entry| entry.position,
            |entry| entry.id,
        );

        assert_eq!(ids, vec!["beta".to_string(), "gamma".to_string()]);
    }
}
