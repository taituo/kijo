//! Everything observable about the core, as plain integers, so two hosts can be compared byte for byte.
use crate::core::{Core, VIEWS};
use serde_json::{json, Value};

pub fn snapshot(core: &mut Core, ret: &[i32]) -> Value {
    let head: Vec<i32> = ["kijo_ws", "kijo_special_open", "kijo_sel_x", "kijo_sel_y", "kijo_focus_x", "kijo_focus_y", "kijo_tile_count", "kijo_workspace_count"].iter().map(|n| core.c(n)).collect();
    let active = core.tiles(None);
    let per_ws: Vec<Vec<i32>> = (0..10).map(|w| core.tiles(Some(w))).collect();
    let views: Vec<Vec<i32>> = (0..VIEWS as i32).map(|v| core.scene(v)).collect();
    let (total, ring) = core.events();
    json!({ "ret": ret, "head": head, "active": active, "ws": per_ws, "views": views, "events": { "total": total, "ring": ring } })
}

/// Run a scenario: [["export", arg, ...], ...]. Returns the final snapshot (return values included).
pub fn run(core: &mut Core, steps: &[Value]) -> Result<Value, String> {
    let mut ret = Vec::new();
    for s in steps {
        let a = s.as_array().ok_or("step must be an array")?;
        let name = a.first().and_then(|v| v.as_str()).ok_or("step needs an export name")?;
        let args: Vec<i32> = a[1..].iter().map(|v| v.as_i64().unwrap_or(0) as i32).collect();
        ret.push(core.call(name, &args)?);
    }
    Ok(snapshot(core, &ret))
}
